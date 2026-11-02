import { describe, expect, test } from "bun:test";
import { checkRedFlags } from "../../router/red_flags";
import { isIdentifierQuestion } from "../../router/index";
import { runCodeChecks, extractNumbers } from "../../compose/checks";
import { PrivacyGuard, buildIdentifiers } from "../../gateway/privacy";
import type { TurnContext } from "../../context/types";
import type { Evidence } from "../../runtime/turn-log";
import type { Composed } from "../../schemas";

// Red flags (8.1), the identifier route, the composer's code checks (12.2)
// and the privacy scanner (6.3), without a database or a model.

const EMERGENCIES = [
  "I have chest pain and I'm sweating",
  "my chest feels tight and the pain is spreading to my jaw",
  "crushing pain in my chest",
  "I think I'm having a heart attack",
  "my face is drooping on one side",
  "my left arm went weak suddenly",
  "I'm slurring my words",
  "worst headache of my life just started",
  "I can't breathe properly",
  "I'm struggling to breathe",
  "I fainted twice today",
  "my husband is having a seizure",
  "my throat is closing up after eating peanuts",
  "my tongue is swelling",
  "I'm bleeding heavily and it won't stop",
  "sudden severe abdominal pain",
  "I took too many pills",
  "I think I overdosed",
  "I want to kill myself",
  "I've been thinking about suicide",
  "I don't want to be alive anymore",
  "I've been self-harming again"
];

const ORDINARY = [
  "What was my last LDL?",
  "How did I sleep last night?",
  "Has my resting heart rate gone up since June?",
  "Does my history mention chest pain back in 2019?",
  "What does a high troponin mean in my records?",
  "My father had a heart attack at 58, what was his age at onset in my family history?",
  "Why is my HRV dropping?",
  "Is my blood pressure trending down?",
  "When did Oura last sync?"
];

describe("red flags", () => {
  for (const m of EMERGENCIES) test(`urgent: ${m}`, () => expect(checkRedFlags(m).urgent).toBe(true));
  for (const m of ORDINARY) test(`not urgent: ${m}`, () => expect(checkRedFlags(m).urgent).toBe(false));
  test("self-harm is never suppressed by historical wording", () => {
    expect(checkRedFlags("my notes from last year mention suicidal thoughts, and I'm having them again").category).toBe("self_harm");
  });
});

describe("identifier questions", () => {
  test("recognised", () => {
    for (const m of ["What's my MRN at Stanford?", "what is my date of birth on file", "tell me my email address"]) expect(isIdentifierQuestion(m)).toBe(true);
    for (const m of ["What was my LDL?", "what's my resting heart rate"]) expect(isIdentifierQuestion(m)).toBe(false);
  });
});

const guard = new PrivacyGuard(buildIdentifiers({
  givenNames: ["Marisol", "May"], familyNames: ["Quintrell"], birthDates: ["1988-04-17"], ids: ["VG-4471902"],
  phones: ["+1-415-555-0142"], emails: ["marisol.quintrell@example.org"], addresses: ["1180 Alder Crest Way"]
}));

describe("privacy guard", () => {
  test("redacts every planted identifier in common formats", () => {
    const text = "Marisol Quintrell (born April 17, 1988, also 04/17/1988 and 1988-04-17), MRN VG-4471902, call (415) 555-0142, marisol.quintrell@example.org, 1180 Alder Crest Way";
    const { text: out, events } = guard.redact(text);
    for (const planted of ["Marisol", "Quintrell", "1988", "VG-4471902", "555-0142", "example.org", "Alder"]) expect(out).not.toContain(planted);
    expect(events.map((e) => e.kind).sort()).toEqual(["address", "birth date", "email", "id", "name", "phone"]);
  });
  test("common words that are also given names are left alone", () => {
    expect(guard.redact("My sleep in May was better").text).toBe("My sleep in May was better");
    expect(guard.redact("May Quintrell").text).not.toContain("Quintrell");
  });
});

function ctx(): TurnContext {
  return {
    now_utc: "2026-11-01T16:00:00Z", timezone: "America/Los_Angeles", local_now: "Sun 1 Nov 2026, 08:00", today: "2026-11-01",
    time_ranges: [], freshness: [
      { kind: "hospital", source: "valley_general", display_name: "Valley General", status: "connected", sandbox: false, last_data_at: null, last_sync_at: "2026-10-15 18:00:00+00", last_error: null, item_count: 10, stale: false },
      { kind: "wearable", source: "whoop", display_name: "Whoop", status: "needs_reconnect", sandbox: false, last_data_at: "2026-09-29 14:36:00+00", last_sync_at: null, last_error: null, item_count: null, stale: true }
    ],
    freshness_text: "", data_inventory: [], inventory_text: "", profile: { age_years: 38, recorded_sex: "female", hospitals: [] },
    memory: [], history: [], history_summary: null, last_evidence: null, zone_notice: null
  };
}

const labEvidence: Evidence = {
  id: "e1", kind: "tool", name: "get_latest_lab", input: {},
  output: [{ result_key: "obs:valley_general:x", test_name: "LDL", value_num: 104, unit: "mg/dL", ref_low: 0, ref_high: 99, date: "2026-08-25", flag: "H", critical: false }],
  provenance: ["obs:valley_general:x"]
};
const rxEvidence: Evidence = { id: "e2", kind: "tool", name: "list_prescriptions", input: {}, output: [{ prescription_key: "rx:valley_general:1", medication: "atorvastatin 20 MG", authored_date: "2023-07-11" }], provenance: ["rx:valley_general:1"] };
const sleepEvidence: Evidence = { id: "e3", kind: "tool", name: "get_sleep_nights", input: { provider: "whoop" }, output: [{ provider: "whoop", day: "2026-09-28", total_sleep_s: 25920 }], provenance: ["records:whoop:sleep:1"] };

function check(answer: string, evidence: Evidence[], lane: "lookup" | "interpretation" = "lookup", claims: Composed["claims"] = [{ text: answer, evidence_ids: evidence.map((e) => e.id), numbers: [], metric_type: null, provider_or_source: null }]) {
  return runCodeChecks({ composed: { answer_markdown: answer, claims, citations: { data: [], web: [] }, follow_up_suggestions: [] }, lane, evidence, ctx: ctx(), question: "q", guard, allowedDomains: ["medlineplus.gov"] }).map((f) => f.check);
}

describe("code checks", () => {
  test("a correct answer passes", () => {
    expect(check("Your latest LDL was 104 mg/dL on 25 Aug 2026, above the lab's range of 0-99 (as of 15 Oct 2026).", [labEvidence])).toEqual([]);
  });
  test("an invented number or date fails", () => {
    expect(check("Your latest LDL was 131 mg/dL on 25 Aug 2026 (as of 15 Oct 2026).", [labEvidence])).toContain("numbers");
    expect(check("Your latest LDL was 104 mg/dL on 3 Mar 2026 (as of 15 Oct 2026).", [labEvidence])).toContain("numbers");
  });
  test("unit conversions and differences are allowed", () => {
    expect(check("Whoop recorded 7.2 hours of sleep (7 h 12 min) on 28 Sep 2026, as of 29 Sep 2026.", [sleepEvidence])).toEqual([]);
    expect(check("Your LDL was 5 mg/dL above the top of the range (104 vs 99), as of 15 Oct 2026.", [labEvidence])).toEqual([]);
  });
  test("claims need evidence", () => {
    expect(check("Your LDL was 104 mg/dL (as of 15 Oct 2026).", [labEvidence], "lookup", [{ text: "LDL 104", evidence_ids: [], numbers: [104], metric_type: null, provider_or_source: null }])).toContain("claims");
    expect(check("Your LDL was 104 mg/dL (as of 15 Oct 2026).", [labEvidence], "lookup", [{ text: "LDL 104", evidence_ids: ["e9"], numbers: [104], metric_type: null, provider_or_source: null }])).toContain("claims");
  });
  test("hospital data and stale providers need 'as of'", () => {
    expect(check("Your latest LDL was 104 mg/dL on 25 Aug 2026.", [labEvidence])).toContain("freshness");
    expect(check("Whoop recorded 7.2 hours of sleep on 28 Sep 2026.", [sleepEvidence])).toContain("freshness");
  });
  test("prescriptions are not 'taken'", () => {
    expect(check("You're taking atorvastatin 20 MG, as of 15 Oct 2026.", [rxEvidence])).toContain("prescriptions");
    expect(check("You were prescribed atorvastatin 20 MG on 11 Jul 2023, as of 15 Oct 2026.", [rxEvidence])).toEqual([]);
  });
  test("scores name their provider", () => {
    const ev: Evidence = { id: "e1", kind: "tool", name: "get_metric_daily", input: { provider: "oura" }, output: [{ provider: "oura", day: "2026-10-31", mean: 82 }], provenance: [] };
    expect(check("Your sleep score was 82 on 31 Oct 2026.", [ev])).toContain("scores");
    expect(check("Oura's sleep score was 82 on 31 Oct 2026.", [ev])).toEqual([]);
  });
  test("cross-provider comparisons of non-comparable metrics fail", () => {
    const ev: Evidence = { id: "e1", kind: "tool", name: "x", input: {}, output: [{ a: 45, b: 52 }], provenance: [] };
    expect(check("Your Oura HRV (45 ms) is lower than your Whoop HRV (52 ms).", [ev])).toContain("providers");
  });
  test("safety: diagnoses, medication instructions, no-doctor reassurance", () => {
    expect(check("You have iron deficiency anemia.", [labEvidence], "interpretation")).toContain("safety");
    expect(check("You should stop taking your statin. Discuss it with your doctor.", [labEvidence], "interpretation")).toContain("safety");
    expect(check("You don't need to see a doctor about this.", [labEvidence])).toContain("safety");
    expect(check("This could have several causes; please discuss it with your doctor.", [], "interpretation", [])).toEqual([]);
  });
  test("critical results are flagged", () => {
    const crit: Evidence = { ...labEvidence, output: [{ ...(labEvidence.output as any[])[0], critical: true }] };
    expect(check("Your latest LDL was 104 mg/dL on 25 Aug 2026 (as of 15 Oct 2026).", [crit])).toContain("safety");
  });
  test("identifiers in an answer fail the privacy check", () => {
    expect(check("Marisol, your LDL was 104 mg/dL on 25 Aug 2026 (as of 15 Oct 2026).", [labEvidence])).toContain("privacy");
  });
  test("numbers glued to names are not data (A1c, B12, SpO2)", () => {
    expect(extractNumbers("Your HbA1c, B12 and SpO2 were checked").map((n) => n.value)).toEqual([]);
  });
});
