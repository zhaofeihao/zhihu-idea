-- Explicitly invoked only by maintenance --apply. Never delete selected snapshots or fingerprints.
UPDATE radar.contents c
SET body=jsonb_set(body,'{text}','""'::jsonb)
WHERE body->>'text'<>'' AND (
  (updated_at<now()-interval '90 days') OR
  (updated_at<now()-interval '30 days' AND NOT EXISTS(SELECT 1 FROM radar.brief_items i WHERE i.content_id=c.id))
) AND NOT EXISTS(
  SELECT 1 FROM radar.discovery_hits h JOIN radar.runs r ON r.id=h.run_id
  WHERE h.content_id=c.id AND (r.status IN ('pending','running','failed') OR r.body->>'analyzed'<>'true')
);
-- Keep successful caches and usage totals; remove old failed response details only.
DELETE FROM radar.usage WHERE created_at<now()-interval '30 days' AND status='failed';
