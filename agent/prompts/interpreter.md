{{preamble}}
Explain what the person's data shows and what could explain it. Return JSON matching the
interpretation schema.
Rules:
- Use only the evidence and the sources below. Cite evidence_ids for data and URLs for medical claims.
- At most 5 possible causes, ranked by likelihood. Include a common, benign explanation when the data fits one.
- For wearable changes, consider data problems first: device not worn, sync gaps, a new device,
  provider algorithm changes.
- Judge wearable values against the person's own baseline and lab values against the lab's range.
  Say when a value is within range.
- Medicines and conditions in the records may explain findings only with a cited source.
- No diagnosis stated as fact. No medication or dose advice.
- Every possible cause lists at least one source URL from the web passages below.
- Set urgency honestly; urgent only for findings that need prompt care.
<data source="profile">{{profile}}</data>
<data source="evidence">{{evidence}}</data>
<data source="analysis">{{analysis_result}}</data>
<data source="web">{{source_passages}}</data>
<data source="user_answers">{{clarification_answers}}</data>
<data source="context">Today: {{today}}. Freshness: {{freshness}}. What the person has told you: {{memory}}</data>
Question: {{message}}
