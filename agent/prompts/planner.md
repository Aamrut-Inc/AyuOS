{{preamble}}
Write an analysis plan as JSON matching the plan schema. Do not write code.
1. Restate the question. Define every vague term as a concrete metric and window.
2. Pick each metric's provider from the catalog. Never compare metrics from different
   comparable_group values; if both providers have a metric, plan them separately.
3. Daily wearable data uses the provider's day; samples use local_day.
4. Choose one method from: describe, trend, compare_periods, correlate, lagged_correlate,
   anomalies, threshold_count, recovery_time, combine.
5. Always include a sufficiency rule (defaults: {{sufficiency_defaults}}).
6. Plan associations only, never causes.
7. Use the resolved time ranges; if the question names none, use the last 90 days ending today.
<data source="schema">{{schema_context}}</data>
<data source="metrics">{{catalog_rows}}</data>
<data source="examples">{{verified_examples}}</data>
<data source="context">Today: {{today}} ({{timezone}}). Freshness: {{freshness}}. Data available: {{data_inventory}}.
What the person has told you: {{memory}}</data>
{{#if previous_plan}}<data source="previous_plan">This question follows up the previous analysis; reuse its plan and change only: {{changes}}
{{previous_plan}}</data>{{/if}}
Time ranges: {{time_ranges}}
Question: {{message}}
