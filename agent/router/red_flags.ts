// Section 8.1: the fixed red-flag check, run in code before any model sees
// the message. These patterns and the urgent template below are the only
// medical rules hard-coded in the agent. The list is deliberately
// conservative: a false alarm costs one extra message, a miss could cost far
// more. Self-harm is never suppressed.

export type RedFlagCategory =
  | "chest_pain"
  | "stroke"
  | "breathing"
  | "consciousness"
  | "allergic_reaction"
  | "bleeding_abdominal_overdose"
  | "self_harm";

interface Rule {
  category: RedFlagCategory;
  patterns: RegExp[];
}

const RULES: Rule[] = [
  {
    category: "chest_pain",
    patterns: [
      /\bchest\s+(pain|pressure|tightness|tightening|heaviness|is\s+(tight|heavy|crushing)|hurts|feels\s+(tight|heavy|crushed))/i,
      /\b(crushing|squeezing)\s+(pain|feeling)\s+in\s+(my\s+)?chest/i,
      /\bpain\s+(spreading|radiating|going|moving)\s+(down\s+|in)?to\s+(my\s+)?(left\s+)?(arm|jaw|neck|shoulder)/i,
      /\bheart\s+attack\b/i
    ]
  },
  {
    category: "stroke",
    patterns: [
      /\b(face|mouth|smile)\s+(is\s+)?(drooping|droops|drooped|lopsided)/i,
      /\b(facial|face)\s+droop/i,
      /\b(one|left|right)\s+side\s+of\s+(my\s+)?(face|body)\s+(is\s+|feels\s+|went\s+)?(numb|weak|paralys|paralyz|droop)/i,
      /\b(sudden(ly)?\s+)?(arm|leg)\s+(weakness|is\s+weak|went\s+weak|went\s+numb|feels\s+numb)/i,
      /\b(slurred|slurring)\s+(speech|my\s+words|words)|\btrouble\s+(speaking|talking|getting\s+words\s+out)|\bcan(no|')?t\s+(speak|talk)\s+(properly|clearly|right)/i,
      /\bsudden(ly)?\s+(confused|confusion|can'?t\s+see|loss\s+of\s+vision|blind)/i,
      /\b(worst|sudden|severe|thunderclap)\s+headache\s+(of\s+my\s+life|ever|out\s+of\s+nowhere)|\bthunderclap\s+headache|\bworst\s+headache\b|\bsudden\s+severe\s+headache/i,
      /\b(having|had)\s+a\s+stroke\b/i
    ]
  },
  {
    category: "breathing",
    patterns: [
      /\bcan(no|')?t\s+(breathe|catch\s+my\s+breath|get\s+(enough\s+)?air)/i,
      /\b(struggling|fighting|gasping)\s+(to\s+breathe|for\s+(air|breath))/i,
      /\b(severe|extreme|really\s+bad)\s+(shortness\s+of\s+breath|difficulty\s+breathing|breathlessness|trouble\s+breathing)/i,
      /\b(lips|face|fingers)\s+(are\s+|turning\s+|went\s+)?(blue|grey|gray)/i
    ]
  },
  {
    category: "consciousness",
    patterns: [
      /\b(just\s+)?(fainted|passed\s+out|blacked\s+out|lost\s+consciousness|losing\s+consciousness|keep\s+fainting)/i,
      /\b(won'?t|can'?t|isn'?t|not)\s+wak(e|ing)\s+up\b/i,
      /\b(having|had|is\s+having)\s+a\s+(seizure|fit|convulsion)|\bseizing\b|\bconvulsing\b/i,
      /\bunconscious\b|\bunresponsive\b/i
    ]
  },
  {
    category: "allergic_reaction",
    patterns: [
      /\b(throat|tongue|lips?|face)\s+(is\s+|are\s+|feels\s+)?(closing|closing\s+up|swelling|swollen|tight)/i,
      /\bswollen\s+(throat|tongue)|\bswelling\s+(of|in)\s+(my\s+)?(throat|tongue)/i,
      /\banaphyla(xis|ctic)\b/i
    ]
  },
  {
    category: "bleeding_abdominal_overdose",
    patterns: [
      /\b(heavy|severe|uncontrolled|a\s+lot\s+of|lots\s+of)\s+bleeding|\bbleeding\s+(heavily|badly|won'?t\s+stop|that\s+won'?t\s+stop|a\s+lot)|\bcan'?t\s+stop\s+(the\s+)?bleeding/i,
      /\b(vomiting|throwing\s+up|coughing\s+up)\s+blood/i,
      /\b(sudden|severe|excruciating|unbearable|worst)\s+(abdominal|stomach|belly)\s+pain/i,
      /\b(over\s*dosed?|overdosing)\b|\btook\s+(too\s+many|way\s+too\s+much|a\s+whole\s+(bottle|pack))/i,
      /\b(swallowed|drank|ate|ingested)\s+(bleach|poison|antifreeze|rat\s+poison|cleaning\s+(fluid|product))|\b(i('?ve| have)\s+been|i\s+was|i\s+think\s+i('?m| am|'ve been))\s+poisoned/i
    ]
  },
  {
    category: "self_harm",
    patterns: [
      /\bsuicid(e|al)\b/i,
      /\b(kill|hurt|harm|cut)\s+my\s*self\b|\bself[\s-]?harm/i,
      /\bend\s+(it\s+all|my\s+(own\s+)?life)\b|\btake\s+my\s+(own\s+)?life\b/i,
      /\b(don'?t|do\s+not)\s+want\s+to\s+(live|be\s+alive|be\s+here\s+anymore|wake\s+up)/i,
      /\bwant\s+to\s+die\b|\bbetter\s+off\s+dead\b|\bno\s+reason\s+to\s+live\b/i
    ]
  }
];

// A question about the record ("does my history mention a seizure?") is not
// an emergency happening now; the model router still sees it. Present-tense
// markers override this, and self-harm is never suppressed.
const HISTORICAL = /\b(records?|notes?|history|chart|diagnos(is|ed)|years?\s+ago|months?\s+ago|weeks?\s+ago|in\s+(19|20)\d\d|last\s+year|back\s+in|what\s+(is|does|causes|are)|explain|mean(s|ing)?|my\s+(mother|father|mom|dad|brother|sister|grandmother|grandfather|aunt|uncle)\s+(had|has|died))/i;
const PRESENT = /\b(right\s+now|now\b|currently|at\s+the\s+moment|today|tonight|just\s+(now|started|happened)|i('?m|\s+am)\s+having|i\s+have|is\s+happening|help\b|911|emergency)/i;

export interface RedFlagResult {
  urgent: boolean;
  category: RedFlagCategory | null;
}

export function checkRedFlags(message: string): RedFlagResult {
  for (const rule of RULES) {
    if (!rule.patterns.some((p) => p.test(message))) continue;
    if (rule.category !== "self_harm" && HISTORICAL.test(message) && !PRESENT.test(message)) continue;
    return { urgent: true, category: rule.category };
  }
  return { urgent: false, category: null };
}

// No phone numbers: the person's country isn't known.
export function urgentMessage(category: RedFlagCategory | null): string {
  const base =
    "What you describe could be a medical emergency. **Please contact your local emergency services now**, " +
    "or have someone take you to the nearest emergency department. Don't wait to see if it passes, and don't rely on this app for this.";
  if (category === "self_harm") {
    return (
      "I'm really sorry you're feeling this way, and I'm glad you said something. **If you might act on these thoughts, please contact your local emergency services now.** " +
      "You can also reach a crisis line in your country, or reach out to someone you trust and tell them how you're feeling right now. " +
      "You don't have to go through this alone."
    );
  }
  return base;
}

// Section 8.1, data red flags: a hospital result carrying a critical
// interpretation code (HH, LL, AA) is flagged first in any answer touching it.
export const CRITICAL_RESULT_NOTICE =
  "One of these results was marked **critical** by the lab that reported it. If you haven't already discussed it with a clinician, please contact one promptly.";
