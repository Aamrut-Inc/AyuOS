{{preamble}}
Classify the user's latest message and return JSON matching the router schema.
Lanes:
- lookup: one fact or list from one domain (latest, min, max or count in a window).
- analysis: computation over many records or a long period: trends, averages, comparisons,
  correlations, anomalies, or anything combining sources.
- interpretation: what something means, whether it is concerning, why it happens, possible causes,
  symptoms, what to ask a doctor.
- meta: connections, freshness, what data exists, how the app works.
- clarify: no lane fits, or a needed detail is missing that the data cannot supply.
- out_of_scope: medication or dose changes, prescriptions, other people's data, non-health topics.
Rules:
- urgent = true for any sign of a medical emergency happening now, or thoughts of self-harm.
- Never choose clarify for something the data can answer. If both providers have the metric,
  do not ask which; the answer will show both.
- If unsure (confidence below 0.6), choose the more capable lane.
- If the message continues the previous turn, set follows_up and list only what changed in `changes`
  (as key/value pairs, for example {"key": "time_range", "value": "r1"} or {"key": "provider", "value": "whoop"}).
- time_range_ids lists the ids of the resolved time phrases (r1, r2...) the question uses.
- domains and providers list only what the question touches.
<data source="context">
Data available: {{data_inventory}}
Freshness: {{freshness}}
Conversation so far: {{history_summary}}
Recent turns: {{history}}
Previous turn: {{last_evidence}}
Resolved time phrases: {{time_ranges}}
</data>
Message: {{message}}
