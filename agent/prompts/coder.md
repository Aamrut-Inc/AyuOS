{{preamble}}
Implement this plan. Return JSON {queries: [{name, sql}], python}.
SQL: single SELECT or WITH statements, only agent.* views, literal dates from the plan,
only the columns you need. Cast dates to text is not needed; dates arrive as ISO strings.
v_readings queries must filter metric_type with = and ts to a range of 31 days or less.
Python: you receive `data`, a dict of pandas DataFrames named after your queries.
Use ayu_stats functions where they fit:
{{ayu_stats_signatures}}
Set `result` to a JSON-serialisable dict containing n, coverage_pct and every number the
answer will need. No file, network or system access; do not import os, sys, subprocess, socket.
{{#if retry}}Previous attempt failed. Cause: {{likely_cause}}. Fix: {{fix_instructions}}.
<data source="previous_code">{{previous_code}}</data>{{/if}}
<data source="schema">{{schema_context}}</data>
<data source="plan">{{plan}}</data>
<data source="examples">{{verified_examples}}</data>
