{{preamble}}
From this exchange, list at most 3 durable facts the person stated about themselves
(goals, preferences, life context, symptoms they described, devices they use).
Return {facts: []} if there are none. Never include names, identifiers, dates of birth, or
anything taken from their records. Return JSON {facts: [{fact_text, category}]}.
<data source="exchange">{{user_message}} / {{final_answer}}</data>
<data source="existing">{{existing_facts}}</data>
