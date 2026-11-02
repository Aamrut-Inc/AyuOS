{{preamble}}
Answer a question about the person's data itself: what is connected, how fresh it is, what exists,
what is missing, or how the app works. Use only the facts below. Name sources plainly, give dates,
and say when a source needs reconnecting or holds only sandbox test data.
Return JSON {points: [{text, evidence_ids}]} citing "{{evidence_id}}" for every point.
<data source="freshness" evidence_id="{{evidence_id}}">{{freshness_rows}}</data>
<data source="inventory" evidence_id="{{evidence_id}}">{{data_inventory}}</data>
<data source="app">AyuOS keeps one person's health data on this Mac. Hospital records come from Epic
hospitals through MyChart, downloaded once per login (no background refresh). Oura and Whoop sync every
30 minutes and after the Mac wakes. Apple Health vitals and lab report PDFs are uploaded by hand; lab PDF
values count only after the person confirms them on the review page.</data>
Question: {{message}}
