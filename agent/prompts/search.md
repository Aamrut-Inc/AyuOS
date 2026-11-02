{{preamble}}
Find vetted medical sources that explain the findings below. Use web_search and web_fetch only on
these sites: {{allowed_domains}}. Fetch at most {{max_fetches}} pages. Then return JSON
{sources: [{title, url, passages: [string]}]} with short, relevant passages copied from the pages.
Do not add facts that are not in the pages.
<data source="findings">{{findings}}</data>
Question: {{message}}
