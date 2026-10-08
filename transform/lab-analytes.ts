// Common lab analytes and the names they appear under on US and Indian lab
// reports. Used to recognize result rows in uploaded PDFs and to give each a
// stable key, so the same test from different labs lines up over time.
//
// `loinc` is a *suggested* LOINC code (the standard ID for a lab test) for the
// most common form of the test, left null where the printed name alone is too
// ambiguous (e.g. "LDL" could be calculated or direct). Reviewers can see and
// override the suggestion; it is not authoritative.

export interface Analyte {
  key: string;
  name: string;
  loinc: string | null;
  aliases: string[];
}

export const ANALYTES: Analyte[] = [
  // Glucose metabolism
  { key: "glucose", name: "Glucose", loinc: "2345-7", aliases: ["glucose", "glucose serum", "glucose plasma", "glucose fasting", "fasting glucose", "fasting blood sugar", "fbs", "blood sugar fasting", "fasting plasma glucose", "fpg", "blood glucose", "glucose random", "random blood sugar", "rbs", "post prandial blood sugar", "ppbs"] },
  { key: "hba1c", name: "Hemoglobin A1c", loinc: "4548-4", aliases: ["hemoglobin a1c", "haemoglobin a1c", "hba1c", "hb a1c", "a1c", "glycated hemoglobin", "glycated haemoglobin", "glycosylated hemoglobin", "glycosylated haemoglobin", "glycohemoglobin"] },
  { key: "insulin", name: "Insulin", loinc: "20448-7", aliases: ["insulin", "insulin fasting", "fasting insulin"] },

  // Kidney
  { key: "bun", name: "Urea nitrogen (BUN)", loinc: "3094-0", aliases: ["bun", "blood urea nitrogen", "urea nitrogen", "urea nitrogen bun"] },
  { key: "urea", name: "Urea", loinc: null, aliases: ["urea", "blood urea", "serum urea"] },
  { key: "creatinine", name: "Creatinine", loinc: "2160-0", aliases: ["creatinine", "serum creatinine", "creatinine serum", "creatinine s"] },
  { key: "egfr", name: "eGFR", loinc: null, aliases: ["egfr", "estimated gfr", "egfr non afr american", "egfr if nonafricn am", "gfr estimated"] },
  { key: "uric_acid", name: "Uric acid", loinc: "3084-1", aliases: ["uric acid", "serum uric acid", "uric acid serum"] },

  // Electrolytes and minerals
  { key: "sodium", name: "Sodium", loinc: "2951-2", aliases: ["sodium", "sodium serum", "serum sodium", "na"] },
  { key: "potassium", name: "Potassium", loinc: "2823-3", aliases: ["potassium", "potassium serum", "serum potassium", "k"] },
  { key: "chloride", name: "Chloride", loinc: "2075-0", aliases: ["chloride", "chloride serum", "serum chloride", "cl"] },
  { key: "co2", name: "Carbon dioxide, total", loinc: "2028-9", aliases: ["carbon dioxide", "carbon dioxide total", "co2", "bicarbonate", "total co2"] },
  { key: "calcium", name: "Calcium", loinc: "17861-6", aliases: ["calcium", "calcium serum", "serum calcium", "calcium total"] },
  { key: "magnesium", name: "Magnesium", loinc: "19123-9", aliases: ["magnesium", "magnesium serum", "serum magnesium"] },
  { key: "phosphorus", name: "Phosphorus", loinc: "2777-1", aliases: ["phosphorus", "phosphorous", "phosphate", "inorganic phosphorus"] },

  // Liver
  { key: "alt", name: "ALT", loinc: "1742-6", aliases: ["alt", "alt sgpt", "sgpt", "sgpt alt", "alanine aminotransferase", "alanine transaminase"] },
  { key: "ast", name: "AST", loinc: "1920-8", aliases: ["ast", "ast sgot", "sgot", "sgot ast", "aspartate aminotransferase", "aspartate transaminase"] },
  { key: "alp", name: "Alkaline phosphatase", loinc: "6768-6", aliases: ["alkaline phosphatase", "alk phos", "alp"] },
  { key: "ggt", name: "GGT", loinc: "2324-2", aliases: ["ggt", "gamma gt", "gamma glutamyl transferase", "ggtp"] },
  { key: "bilirubin_total", name: "Bilirubin, total", loinc: "1975-2", aliases: ["bilirubin total", "total bilirubin", "bilirubin"] },
  { key: "albumin", name: "Albumin", loinc: "1751-7", aliases: ["albumin", "albumin serum", "serum albumin"] },
  { key: "protein_total", name: "Protein, total", loinc: "2885-2", aliases: ["protein total", "total protein", "protein total serum"] },

  // Lipids
  { key: "cholesterol_total", name: "Cholesterol, total", loinc: "2093-3", aliases: ["cholesterol total", "total cholesterol", "cholesterol", "serum cholesterol"] },
  { key: "triglycerides", name: "Triglycerides", loinc: "2571-8", aliases: ["triglycerides", "triglyceride", "serum triglycerides"] },
  { key: "hdl", name: "HDL cholesterol", loinc: "2085-9", aliases: ["hdl cholesterol", "hdl", "hdl chol", "cholesterol hdl", "hdl c"] },
  { key: "ldl_calc", name: "LDL cholesterol (calculated)", loinc: "13457-7", aliases: ["ldl chol calc", "ldl chol calc nih", "ldl calculated", "ldl cholesterol calculated", "calculated ldl"] },
  { key: "ldl_direct", name: "LDL cholesterol (direct)", loinc: "18262-6", aliases: ["ldl direct", "direct ldl", "ldl cholesterol direct"] },
  { key: "ldl", name: "LDL cholesterol", loinc: null, aliases: ["ldl cholesterol", "ldl", "ldl c", "cholesterol ldl"] },
  { key: "non_hdl", name: "Non-HDL cholesterol", loinc: "43396-1", aliases: ["non hdl cholesterol", "non hdl", "non hdl c"] },
  { key: "vldl", name: "VLDL cholesterol", loinc: null, aliases: ["vldl cholesterol", "vldl", "vldl chol cal"] },
  { key: "apob", name: "Apolipoprotein B", loinc: "1884-6", aliases: ["apolipoprotein b", "apo b", "apob"] },
  { key: "lpa", name: "Lipoprotein(a)", loinc: null, aliases: ["lipoprotein a", "lipoprotein (a)", "lp a", "lpa"] },

  // Thyroid
  { key: "tsh", name: "TSH", loinc: "3016-3", aliases: ["tsh", "thyroid stimulating hormone", "tsh ultrasensitive", "tsh 3rd generation"] },
  { key: "free_t4", name: "Free T4", loinc: "3024-7", aliases: ["free t4", "t4 free", "ft4", "free thyroxine", "t4 free direct"] },
  { key: "free_t3", name: "Free T3", loinc: "3051-0", aliases: ["free t3", "t3 free", "ft3", "free triiodothyronine"] },
  { key: "t4_total", name: "T4, total", loinc: null, aliases: ["t4", "t4 total", "total t4", "thyroxine"] },
  { key: "t3_total", name: "T3, total", loinc: null, aliases: ["t3", "t3 total", "total t3", "triiodothyronine"] },

  // Vitamins and iron
  { key: "vitamin_d_25oh", name: "Vitamin D, 25-hydroxy", loinc: "62292-8", aliases: ["vitamin d 25 hydroxy", "vitamin d 25 oh", "25 oh vitamin d", "25 hydroxy vitamin d", "vitamin d", "vitamin d total", "25 oh vit d", "vit d 25 oh", "vitamin d3 25 oh"] },
  { key: "vitamin_b12", name: "Vitamin B12", loinc: "2132-9", aliases: ["vitamin b12", "vit b12", "b12", "cobalamin", "vitamin b12 cyanocobalamin"] },
  { key: "folate", name: "Folate", loinc: "2284-8", aliases: ["folate", "folic acid", "folate serum"] },
  { key: "ferritin", name: "Ferritin", loinc: "2276-4", aliases: ["ferritin", "serum ferritin", "ferritin serum"] },
  { key: "iron", name: "Iron", loinc: "2498-4", aliases: ["iron", "iron serum", "serum iron", "iron total"] },
  { key: "tibc", name: "Iron binding capacity (TIBC)", loinc: "2500-7", aliases: ["tibc", "total iron binding capacity", "iron binding capacity"] },
  { key: "transferrin_sat", name: "Transferrin saturation", loinc: "2502-3", aliases: ["transferrin saturation", "iron saturation", "tsat", "iron saturation percent"] },

  // Complete blood count
  { key: "hemoglobin", name: "Hemoglobin", loinc: "718-7", aliases: ["hemoglobin", "haemoglobin", "hb", "hgb", "haemoglobin hb", "hemoglobin hb"] },
  { key: "hematocrit", name: "Hematocrit", loinc: "4544-3", aliases: ["hematocrit", "haematocrit", "hct", "pcv", "packed cell volume"] },
  { key: "wbc", name: "White blood cells", loinc: "6690-2", aliases: ["wbc", "wbc count", "white blood cell count", "white blood cells", "total leucocyte count", "total leukocyte count", "tlc", "total wbc count", "leukocytes"] },
  { key: "rbc", name: "Red blood cells", loinc: "789-8", aliases: ["rbc", "rbc count", "red blood cell count", "red blood cells", "total rbc count", "erythrocytes"] },
  { key: "platelets", name: "Platelets", loinc: "777-3", aliases: ["platelets", "platelet count", "plt", "platelet"] },
  { key: "mcv", name: "MCV", loinc: "787-2", aliases: ["mcv", "mean corpuscular volume"] },
  { key: "mch", name: "MCH", loinc: "785-6", aliases: ["mch", "mean corpuscular hemoglobin", "mean corpuscular haemoglobin"] },
  { key: "mchc", name: "MCHC", loinc: "786-4", aliases: ["mchc", "mean corpuscular hemoglobin concentration", "mean corpuscular haemoglobin concentration"] },
  { key: "rdw", name: "RDW", loinc: "788-0", aliases: ["rdw", "rdw cv", "red cell distribution width"] },
  { key: "neutrophils", name: "Neutrophils", loinc: null, aliases: ["neutrophils", "neutrophil", "polymorphs", "neutrophils absolute"] },
  { key: "lymphocytes", name: "Lymphocytes", loinc: null, aliases: ["lymphocytes", "lymphocyte", "lymphs", "lymphocytes absolute"] },
  { key: "monocytes", name: "Monocytes", loinc: null, aliases: ["monocytes", "monocyte", "monocytes absolute"] },
  { key: "eosinophils", name: "Eosinophils", loinc: null, aliases: ["eosinophils", "eosinophil", "eos", "eosinophils absolute"] },
  { key: "basophils", name: "Basophils", loinc: null, aliases: ["basophils", "basophil", "basos", "basophils absolute"] },
  { key: "esr", name: "ESR", loinc: null, aliases: ["esr", "erythrocyte sedimentation rate", "sed rate"] },

  // Inflammation, hormones, other
  { key: "crp", name: "C-reactive protein", loinc: "1988-5", aliases: ["crp", "c reactive protein", "c-reactive protein"] },
  { key: "hs_crp", name: "hs-CRP", loinc: "30522-7", aliases: ["hs crp", "hscrp", "high sensitivity crp", "c reactive protein cardiac", "crp high sensitivity"] },
  { key: "homocysteine", name: "Homocysteine", loinc: "13965-9", aliases: ["homocysteine", "homocysteine serum"] },
  { key: "psa", name: "PSA", loinc: "2857-1", aliases: ["psa", "prostate specific ag", "prostate specific antigen", "psa total"] },
  { key: "cortisol", name: "Cortisol", loinc: "2143-6", aliases: ["cortisol", "cortisol serum", "cortisol morning"] },
  { key: "testosterone_total", name: "Testosterone, total", loinc: "2986-8", aliases: ["testosterone", "testosterone total", "total testosterone"] }
];

// Lowercase, drop punctuation and specimen prefixes so "Cholesterol, Total",
// "CHOLESTEROL TOTAL" and "Serum Cholesterol - Total" compare equal.
export function normalizeAnalyteName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b\d{2}\b$/, "") // LabCorp footnote numbers ("Cholesterol, Total 01")
    .replace(/[^a-z0-9()]+/g, " ")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const byAlias = new Map<string, Analyte>();
for (const analyte of ANALYTES) {
  for (const alias of analyte.aliases) byAlias.set(normalizeAnalyteName(alias), analyte);
}

export function findAnalyte(printedName: string): Analyte | null {
  const normalized = normalizeAnalyteName(printedName);
  const exact = byAlias.get(normalized);
  if (exact) return exact;

  // Tolerate method/specimen suffixes: "Creatinine, Serum (Jaffe)" → "creatinine serum jaffe".
  // Ratios ("Cholesterol/HDL Ratio") are separate tests, never their prefix.
  if (/\bratio\b/.test(normalized)) return null;
  const words = normalized.split(" ");
  for (let n = words.length - 1; n >= 1; n--) {
    const prefix = words.slice(0, n).join(" ");
    const match = byAlias.get(prefix);
    // Single short tokens ("k", "na", "hb") only count as exact matches.
    if (match && prefix.length >= 3) return match;
  }
  return null;
}
