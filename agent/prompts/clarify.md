{{preamble}}
Before explaining this, decide whether to ask the person up to 2 short questions about things the data
cannot show: onset, duration, severity, other symptoms, recent illness, travel, medicines not in the
records. Never ask about anything the data shows (it is summarised below). If the evidence is enough,
return no questions.
Return JSON {questions: [string]}.
<data source="evidence_summary">{{evidence_summary}}</data>
<data source="already_asked">{{already_asked}}</data>
Question: {{message}}
