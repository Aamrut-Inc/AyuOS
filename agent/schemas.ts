import { z } from "zod/v4";

// Structured model outputs (sections 8-13). These schemas are the source of
// truth; prompts describe them in words.

export const DOMAINS = ["labs", "vitals", "conditions", "medications", "allergies", "immunizations", "encounters", "procedures", "notes", "sleep", "recovery", "activity", "workouts", "heart", "body", "data_status"] as const;
export const LANES = ["lookup", "analysis", "interpretation", "meta", "clarify", "out_of_scope"] as const;

export const RouterOutput = z.object({
  urgent: z.boolean(),
  urgent_reason: z.string().nullable(),
  lane: z.enum(LANES),
  domains: z.array(z.enum(DOMAINS)),
  providers: z.array(z.enum(["oura", "whoop", "apple_health"])),
  time_range_ids: z.array(z.string()),
  follows_up: z.boolean(),
  changes: z.array(z.object({ key: z.string(), value: z.string() })),
  clarifying_question: z.string().nullable(),
  out_of_scope_reason: z.string().nullable(),
  confidence: z.number().min(0).max(1)
});
export type Route = z.infer<typeof RouterOutput>;

export const Point = z.object({ text: z.string(), evidence_ids: z.array(z.string()) });

export const LookupOutput = z.object({
  points: z.array(Point),
  not_found: z.array(z.object({ what: z.string(), searched: z.string() })),
  needs_analysis: z.boolean()
});
export type LookupResult = z.infer<typeof LookupOutput>;

export const MetaOutput = z.object({ points: z.array(Point) });

export const ComposerOutput = z.object({
  answer_markdown: z.string(),
  claims: z.array(
    z.object({
      text: z.string(),
      evidence_ids: z.array(z.string()),
      numbers: z.array(z.number()),
      metric_type: z.string().nullable(),
      provider_or_source: z.string().nullable()
    })
  ),
  citations: z.object({
    data: z.array(z.object({ view: z.string(), source: z.string(), date_range: z.string().nullable(), evidence_id: z.string() })),
    web: z.array(z.object({ title: z.string(), url: z.string(), accessed: z.string() }))
  }),
  follow_up_suggestions: z.array(z.string()).max(2)
});
export type Composed = z.infer<typeof ComposerOutput>;

export const VerifierOutput = z.object({
  pass: z.boolean(),
  failures: z.array(z.object({ check: z.string(), reason: z.string() })),
  fix_notes: z.string().nullable()
});

export const MemoryOutput = z.object({
  facts: z.array(z.object({ fact_text: z.string(), category: z.enum(["goal", "preference", "context", "symptom_history", "device"]) })).max(3)
});

export const SummaryOutput = z.object({ summary: z.string() });

export const METHODS = ["describe", "trend", "compare_periods", "correlate", "lagged_correlate", "anomalies", "threshold_count", "recovery_time", "combine"] as const;

export const PlanOutput = z.object({
  restated_question: z.string(),
  definitions: z.array(z.object({ term: z.string(), means: z.string() })),
  time_window: z.object({ from: z.string(), to: z.string(), label: z.string(), tz: z.string() }),
  data: z.array(z.object({ view: z.string(), provider: z.string().nullable(), metric_type: z.string().nullable(), grain: z.string() })),
  alignment: z.object({ unit: z.string(), lag_days: z.array(z.number()) }),
  method: z.enum(METHODS),
  sufficiency: z.object({ min_days_per_group: z.number().nullable(), min_n: z.number().nullable(), min_coverage_pct: z.number().nullable() }),
  empty_is_meaningful: z.boolean(),
  outputs: z.array(z.string()),
  caveats: z.array(z.string())
});
export type Plan = z.infer<typeof PlanOutput>;

export const CoderOutput = z.object({
  queries: z.array(z.object({ name: z.string().regex(/^[a-z_][a-z0-9_]*$/), sql: z.string() })).min(1).max(6),
  python: z.string()
});
export type Program = z.infer<typeof CoderOutput>;

export const ExplainerOutput = z.object({ likely_cause: z.string(), fix_instructions: z.string() });

export const InterpretationOutput = z.object({
  summary: z.string(),
  what_the_data_shows: z.array(Point),
  possible_causes: z
    .array(
      z.object({
        name: z.string(),
        likelihood: z.enum(["more likely", "possible", "less likely"]),
        supporting: z.array(Point),
        against: z.array(Point),
        sources: z.array(z.string())
      })
    )
    .max(5),
  red_flags_to_watch: z.array(z.string()),
  questions_for_doctor: z.array(z.string()),
  general_suggestions: z.array(z.object({ text: z.string(), sources: z.array(z.string()) })),
  urgency: z.enum(["routine", "soon", "urgent"]),
  data_gaps: z.array(z.string()),
  confidence_note: z.string()
});
export type Interpretation = z.infer<typeof InterpretationOutput>;

export const ClarifyOutput = z.object({ questions: z.array(z.string()).max(2) });

export const SourcesOutput = z.object({
  sources: z.array(z.object({ title: z.string(), url: z.string(), passages: z.array(z.string()) })).max(6)
});
