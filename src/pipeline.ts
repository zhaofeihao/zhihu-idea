import { randomUUID } from "node:crypto";
import {
  hash,
  score,
  selectBrief,
  screenSchema,
  normalizeTopic,
  builtinLabels,
  type Brief,
  type BriefItem,
  type Content,
  type Query,
  type Source,
  type Screening,
  type Analysis,
} from "./domain.js";
import { day } from "./domain.js";
import { safeError, type Config } from "./config.js";
import {
  cacheKey,
  reservation,
  estimatedCost,
  ModelError,
  InvalidResultError,
  validateAnalysis,
  type Model,
  type Phase,
} from "./models.js";
import type { RunState, Store } from "./storage.js";

export class BudgetStop extends Error {
  constructor() {
    super("当天调用/token/费用预算已到上限，停止新增请求");
  }
}
export function queryPlan(c: Config, date: string): Query[] {
  const rotation = Math.floor(Date.parse(date) / 86400000);
  const queries: Query[] = [];
  const active = c.category ? [c.category] : Object.keys(c.discovery.queries);
  for (let i = 0; i < c.limits.queries; i++) {
    const category = active[i % active.length],
      pool = c.discovery.queries[category];
    const text = pool[(rotation + Math.floor(i / active.length)) % pool.length];
    const variant = (rotation + Math.floor(i / active.length)) % 3;
    const sort =
      variant === 0
        ? `VoteUpCount:desc:(,${c.discovery.lowVoteMax})`
        : variant === 1
          ? "EditTime:asc"
          : undefined;
    const kind =
      c.discovery.recommendations && i >= Math.floor(c.limits.queries * 0.8)
        ? "recommend"
        : "search";
    const id = hash(JSON.stringify({ kind, text, sort }));
    if (!queries.some((q) => q.id === id))
      queries.push({
        id,
        kind,
        text,
        category,
        ...(kind === "search" ? { sort } : {}),
      });
  }
  if (c.discovery.hot)
    queries.push({ id: "hot", kind: "hot", text: "", category: active[0] });
  return queries;
}
export async function withLease<T>(
  store: Store,
  namespace: string,
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const owner = randomUUID();
  if (!(await store.lease(namespace, owner)))
    throw new Error("该运行空间已有任务执行中，请等待完成或租约过期");
  const control = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, control.signal])
    : control.signal;
  let renewing = false;
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void store
      .renew(namespace, owner)
      .then((ok) => {
        if (!ok) control.abort();
      })
      .catch(() => control.abort())
      .finally(() => {
        renewing = false;
      });
  }, 20000);
  timer.unref();
  try {
    return await operation(combined);
  } finally {
    clearInterval(timer);
    await store.release(namespace, owner);
  }
}
export interface RunOptions {
  resume?: string;
  revision?: string;
  stage?: "discover" | "analyze" | "all";
  signal?: AbortSignal;
  deadline?: number;
}
export class Pipeline {
  constructor(
    public store: Store,
    private source: Source,
    private model: Model,
    private log: (message: string) => void = console.log,
  ) {}
  async run(
    config: Config,
    options: RunOptions = {},
  ): Promise<{ run: RunState; brief: Brief | null }> {
    const cycleDay = day();
    const id =
      options.resume ||
      hash(
        `${config.namespace}:${cycleDay}:${options.revision || "default"}:${hash(JSON.stringify(config))}`,
      ).slice(0, 24);
    let state = await this.store.run(id);
    if (options.resume && !state) throw new Error("找不到要恢复的 run ID");
    if (state && state.namespace !== config.namespace)
      throw new Error("该运行不属于当前运行空间");
    if (!state)
      state = {
        id,
        namespace: config.namespace,
        date: cycleDay,
        config,
        preferences: await this.store.preferences(config.namespace),
        queue: queryPlan(config, cycleDay),
        cursor: 0,
        contentIds: [],
        discovered: false,
        analyzed: false,
        explored: false,
        errors: [],
        status: "pending",
        deepIds: [],
      };
    const run = state;
    const timeout =
      options.deadline === undefined
        ? null
        : AbortSignal.timeout(Math.max(1, options.deadline - Date.now()));
    const executionSignal = timeout
      ? AbortSignal.any([timeout, ...(options.signal ? [options.signal] : [])])
      : options.signal;
    return withLease(
      this.store,
      run.namespace,
      async (signal) => {
        const existing = await this.store.brief(run.id);
        if (existing) {
          this.log(`复用已有简报 ${run.id}`);
          return { run, brief: existing };
        }
        run.status = "running";
        await this.store.saveRun(run);
        this.log(`run ID: ${run.id}`);
        try {
          if (options.stage !== "analyze") await this.discover(run, signal);
          if (options.stage === "discover") {
            run.status = "succeeded";
            await this.store.saveRun(run);
            return { run, brief: null };
          }
          if (!run.discovered && options.stage === "analyze")
            throw new Error("该次运行的发现阶段未完成，请先恢复采集");
          let budgetStopped = false;
          try {
            await this.analyze(
              run,
              signal,
              Math.max(1, Math.floor(run.config.limits.deep * 0.8)),
            );
          } catch (error) {
            if (!(error instanceof BudgetStop)) throw error;
            budgetStopped = true;
            run.errors.push(error.message);
          }
          if (!run.explored && !budgetStopped) {
            const found = await this.deepResults(run);
            const queries: Query[] = [];
            for (const item of found
              .filter((x) => x.score >= run.config.selection.minScore)
              .sort((a, b) => b.score - a.score)
              .slice(0, 5)) {
              for (const text of item.analysis.followUpQueries.slice(0, 2)) {
                const id = hash("explore:" + text.trim());
                if (
                  !run.queue.some((q) => q.id === id) &&
                  !queries.some((q) => q.id === id)
                )
                  queries.push({
                    id,
                    kind: "search",
                    text: text.trim(),
                    category: item.analysis.category,
                    parent: item.content.id,
                  });
              }
            }
            run.queue.push(...queries.slice(0, run.config.limits.exploration));
            run.explored = true;
            // Reserve a small separate discovery allowance for follow-ups even when base candidates filled.
            run.discovered = false;
            await this.store.saveRun(run);
            await this.discover(run, signal, true);
          }
          if (!budgetStopped)
            try {
              await this.analyze(run, signal, run.config.limits.deep);
            } catch (error) {
              if (!(error instanceof BudgetStop)) throw error;
              run.errors.push(error.message);
            }
          return await this.compose(run);
        } catch (error) {
          if (
            timeout?.aborted &&
            !options.signal?.aborted &&
            signal.reason === timeout.reason
          ) {
            run.errors.push(
              "已到采集截止时间，仅选编已完成分析；未完成部分以后可重新发现",
            );
            return this.compose(run, true);
          }
          run.status = "failed";
          run.errors.push(safeError(error));
          await this.store.saveRun(run);
          throw error;
        }
      },
      executionSignal,
    );
  }
  private async compose(
    run: RunState,
    deadline = false,
  ): Promise<{ run: RunState; brief: Brief }> {
    const candidates = await this.deepResults(run);
    const history = await this.store.history(run.namespace);
    if (
      !deadline &&
      !candidates.length &&
      run.errors.some((error) => error.includes("预算"))
    )
      throw new BudgetStop();
    const eligible = candidates.filter(
      (x) =>
        !history.fingerprints.has(x.content.fingerprint) &&
        !history.topics.has(normalizeTopic(x.analysis.topicKey)),
    );
    const items = selectBrief(
      eligible,
      history.ids,
      run.config.limits.brief,
      run.config.selection.minScore,
      run.config.selection.minEvidence,
    );
    // 快照入选话题的展示名，预览/发送即使之后改了配置也稳定。
    const labelMap: Record<string, string> = {};
    for (const key of [
      ...Object.keys(run.config.discovery.queries),
      ...items.map((x) => x.analysis.category),
    ])
      labelMap[key] =
        run.config.topics?.[key]?.label ?? builtinLabels[key] ?? key;
    const brief: Brief = {
      id: run.id,
      date: run.date,
      namespace: run.namespace,
      items,
      status: items.length ? "ready" : "empty",
      createdAt: new Date().toISOString(),
      warnings: run.errors.slice(-3),
      labels: labelMap,
    };
    await this.store.saveBrief(brief);
    run.analyzed = true;
    run.status = "succeeded";
    await this.store.saveRun(run);
    this.log(
      `候选 ${run.contentIds.length} 条，深度分析 ${run.deepIds.length} 条，精选 ${items.length} 条`,
    );
    return { run, brief };
  }
  private async discover(
    run: RunState,
    signal: AbortSignal,
    exploration = false,
  ) {
    if (run.discovered) return;
    const c = run.config;
    const cap =
      c.limits.candidates +
      (exploration || run.explored ? c.limits.exploration * 10 : 0);
    while (run.cursor < run.queue.length && run.contentIds.length < cap) {
      signal.throwIfAborted();
      const q = run.queue[run.cursor];
      const reservation = { source: 1, calls: 0, tokens: 0, cost: 0 };
      if (
        !(await this.store.reserve(run.namespace, day(), reservation, c.limits))
      ) {
        run.errors.push("采集因当天预算停止，覆盖有限");
        break;
      }
      const page = await this.source.fetch(
        q,
        Math.min(q.kind === "answers" ? 50 : 10, cap - run.contentIds.length),
        signal,
      );
      for (const item of page.items) {
        await this.store.putContent(item, run.id, q);
        if (!run.contentIds.includes(item.id)) {
          run.contentIds.push(item.id);
          if (run.explored && q.kind === "search" && q.parent)
            (run.explorationIds ??= []).push(item.id);
        }
      }
      const expanded =
        this.source.expand?.(q, page, run.queue, {
          questionAnswers: c.discovery.recommendations,
          answerPages: c.limits.answerPages,
        }) ?? [];
      // A title-only recommendation must reach answers before the base candidate cap fills.
      run.queue.splice(
        run.cursor + 1,
        0,
        ...expanded.filter((next) => !run.queue.some((x) => x.id === next.id)),
      );
      run.cursor++;
      await this.store.saveRun(run);
      this.log(
        `发现 ${run.cursor}/${run.queue.length}：已收集 ${run.contentIds.length} 条`,
      );
    }
    if (run.cursor < run.queue.length && run.contentIds.length >= cap) {
      run.queue = run.queue.slice(0, run.cursor);
    }
    run.discovered = true;
    await this.store.saveRun(run);
  }
  private async call(
    phase: Phase,
    item: Content,
    run: RunState,
    signal: AbortSignal,
  ): Promise<Screening | Analysis> {
    const key = cacheKey(phase, item, run.preferences, run.config);
    const cached = await this.store.cached<Screening | Analysis>(key);
    if (cached) return cached;
    const reserved = reservation(phase, item, run.preferences, run.config);
    const date = day();
    const limits = { ...run.config.limits };
    if (phase === "screen") {
      // Keep room for deeper decisions; coarse screening must not spend the entire day budget.
      const deeper = reservation("analyze", item, run.preferences, run.config);
      const slots = Math.min(
        Math.max(1, limits.deep - run.deepIds.length),
        Math.max(1, Math.floor(limits.dailyModelCalls / 4)),
      );
      limits.dailyModelCalls = Math.max(0, limits.dailyModelCalls - slots);
      limits.dailyTokens = Math.max(0, limits.dailyTokens - deeper.tokens);
      if (limits.dailyCost !== null)
        limits.dailyCost = Math.max(0, limits.dailyCost - deeper.cost);
    }
    if (!(await this.store.reserve(run.namespace, date, reserved, limits)))
      throw new BudgetStop();
    const usage = {
      id: randomUUID(),
      runId: run.id,
      phase,
      provider: run.config.models[phase].provider,
      model: run.config.models[phase].model,
    };
    let input: number | null = null,
      output: number | null = null;
    let status = "failed";
    try {
      signal.throwIfAborted();
      const result = await this.model.generate(
        phase,
        item,
        run.preferences,
        run.config,
        signal,
      );
      input = result.input;
      output = result.output;
      let value: Screening | Analysis;
      try {
        value =
          phase === "screen"
            ? screenSchema(Object.keys(run.config.discovery.queries)).parse(
                result.value,
              )
            : validateAnalysis(result.value, item, run.config);
      } catch (cause) {
        // Structurally returned but unusable (bad schema / fabricated evidence):
        // skip this single item instead of aborting the whole run.
        throw new InvalidResultError(
          phase,
          cause instanceof Error
            ? cause.message
            : "模型返回结果未通过校验，已跳过该条",
          cause,
        );
      }
      await this.store.cache(key, item.id, phase, value);
      status = "succeeded";
      return value;
    } catch (error) {
      if (error instanceof ModelError) {
        input = error.input;
        output = error.output;
      }
      throw error;
    } finally {
      const cost = estimatedCost(phase, input, output, run.config);
      await this.store.settle(
        run.namespace,
        date,
        reserved,
        input === null || output === null ? null : input + output,
        cost,
        { ...usage, input, output, cost, status },
      );
    }
  }
  private async analyze(run: RunState, signal: AbortSignal, cap: number) {
    const all = await this.store.contents(run.contentIds);
    const history = await this.store.history(run.namespace);
    const seen = new Set<string>();
    const kept: Content[] = [];
    const rejected: Content[] = [];
    // Round-robin categories at discovery time and preserve its order even when SQL returns unordered rows.
    const lookup = new Map(all.map((x) => [x.id, x]));
    const explorationIds = run.explored ? (run.explorationIds ?? []) : [];
    const orderedIds = [
      ...explorationIds,
      ...run.contentIds.filter((id) => !explorationIds.includes(id)),
    ];
    for (const id of orderedIds) {
      const item = lookup.get(id);
      if (
        !item ||
        !item.text ||
        item.scope === "title_only" ||
        history.ids.has(id) ||
        seen.has(item.fingerprint)
      )
        continue;
      seen.add(item.fingerprint);
      let s: Screening;
      try {
        s = (await this.call("screen", item, run, signal)) as Screening;
      } catch (error) {
        if (error instanceof BudgetStop) {
          run.errors.push(
            "初筛预算有限，停止初筛并把剩余额度用于已发现候选的深度分析",
          );
          break;
        }
        // Skip a single candidate that fails to screen (truncated output or a
        // result that doesn't pass validation) rather than aborting the run.
        if (
          error instanceof ModelError ||
          error instanceof InvalidResultError
        ) {
          const warning = "部分内容未能完成初筛，已跳过并继续";
          if (!run.errors.includes(warning)) run.errors.push(warning);
          continue;
        }
        throw error;
      }
      if (s.decision === "keep") kept.push(item);
      else if (s.decision === "reject") rejected.push(item);
      if (kept.length >= run.config.limits.screenKeep) break;
    }
    const candidates = [...kept];
    for (const item of rejected
      .sort((a, b) =>
        hash(a.id + run.date).localeCompare(hash(b.id + run.date)),
      )
      .slice(0, run.config.selection.auditRejected))
      if (!candidates.some((x) => x.id === item.id)) candidates.push(item);
    // Analyze passing candidates first; audits use remaining slots and the same daily budgets.
    for (const item of candidates) {
      if (run.deepIds.includes(item.id)) continue;
      if (run.deepIds.length >= cap) break;
      signal.throwIfAborted();
      try {
        await this.call("analyze", item, run, signal);
      } catch (error) {
        // A single item whose output can't be parsed (e.g. truncated at the
        // token cap) or fails validation (e.g. fabricated evidence quotes) must
        // not abort the whole run nor loop forever on resume.
        if (
          !(error instanceof ModelError) &&
          !(error instanceof InvalidResultError)
        )
          throw error;
        const warning = "部分内容未能生成有效分析，已跳过并继续";
        if (!run.errors.includes(warning)) run.errors.push(warning);
        await this.store.saveRun(run);
        continue;
      }
      run.deepIds.push(item.id);
      await this.store.saveRun(run);
      this.log(`深度分析 ${run.deepIds.length}/${run.config.limits.deep}`);
    }
  }
  private async deepResults(run: RunState): Promise<BriefItem[]> {
    const items = await this.store.contents(run.deepIds);
    const results: BriefItem[] = [];
    for (const item of items) {
      // Rejected samples may be audited, but cannot seed exploration or enter a brief.
      const screening = await this.store.cached<Screening>(
        cacheKey("screen", item, run.preferences, run.config),
      );
      if (screening?.decision !== "keep") continue;
      const a = await this.store.cached<Analysis>(
        cacheKey("analyze", item, run.preferences, run.config),
      );
      if (a)
        results.push({
          content: { ...item, text: "" },
          analysis: a,
          score: score(a, run.config.topics),
        });
    }
    return results;
  }
}
