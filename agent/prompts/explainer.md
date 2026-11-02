{{preamble}}
The analysis code below failed or returned no rows. Compare the code with the error,
the schema and the sample rows, and find the single most likely cause. Be specific:
name the column, value, type or join that is wrong. Return JSON {likely_cause, fix_instructions}.
<data source="question">{{message}}</data>
<data source="plan">{{plan}}</data>
<data source="code">{{queries_and_python}}</data>
<data source="error">{{error_or_empty_notice}}</data>
<data source="schema">{{schema_context_subset}}</data>
<data source="samples">{{sample_rows}}</data>
