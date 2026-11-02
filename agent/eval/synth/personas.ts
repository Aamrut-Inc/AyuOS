// The ten synthetic personas of the evaluation databases (section 18.1). One
// database per persona (ayuos_eval_<id>), because AyuOS holds one person per
// install. Every identifier here is invented and planted on purpose so the
// privacy tests can search outbound payloads for it.

export interface LabSeries {
  loinc: string;
  name: string;
  unit: string;
  refLow: number | null;
  refHigh: number | null;
  // Values at the persona's lab dates (index-aligned with Persona.labDates).
  values: number[];
  // A critical interpretation code on the last value (data red flag, 8.1).
  criticalLast?: "HH" | "LL";
}

export interface Persona {
  id: string;
  profile: string;
  tz: string;
  sex: "male" | "female";
  birthDate: string;
  identifiers: { given: string; family: string; mrn: string; email: string; phone: string; street: string; city: string };
  providers: Array<"oura" | "whoop" | "apple_health">;
  // Dense per-sample heart rate interval while awake (minutes).
  hrIntervalMin: number;
  wearable: {
    restingHr: number;
    restingHrTrendPerWeek: number; // bpm per week, a built-in trend
    hrvBase: number; // ms
    sleepHours: number;
    sleepSdMin: number;
    // HRV the next day drops by this many ms per hour of sleep below the mean (lag-1 relationship).
    hrvPerSleepHour: number;
    stepsBase: number;
    workoutsPerWeek: number;
    napsPerWeek: number;
    // Illness-like episodes: resting HR up, temperature deviation up.
    anomalies: Array<{ startDay: number; days: number; hrDelta: number; tempDelta: number }>;
    // Days with no data at all (sync gap) and days the device wasn't worn.
    gaps: Array<{ startDay: number; days: number }>;
    nonWearDays: number[];
    // A trip: the wearables report this fixed offset for these days.
    trip?: { startDay: number; days: number; offsetMinutes: number };
    // An injury: activity drops at this day and recovers over `days`.
    injury?: { day: number; days: number };
  };
  conditions: Array<{ name: string; icd10: string; snomed: string; onset: string; status: "active" | "resolved"; verification?: string }>;
  medications: Array<{ name: string; rxnorm?: string; dosage: string; status: string; authoredOn: string }>;
  allergies: Array<{ substance: string; reaction: string; severity: string; criticality: string }>;
  labDates: string[];
  labs: LabSeries[];
  bp: Array<{ date: string; systolic: number; diastolic: number }>;
  familyHistory: Array<{ relationship: string; condition: string; onsetAge: number }>;
}

// Synthetic data covers the year ending on this day (local).
export const END_DAY = "2026-10-31";
export const DAYS = 365;
export const IMPORT_DAY = "2026-10-15";
export const HOSPITAL = { slug: "valley_general", name: "Valley General Hospital (synthetic)", url: "https://fhir.valley-general.example/api/FHIR/R4" };
export const SANDBOX = { slug: "epic_sandbox", name: "Epic sandbox (test patients, not a real hospital)", url: "https://fhir.epic.example/sandbox/api/FHIR/R4" };

const lipids = (ldl: number[], hdl: number[], tc: number[], tg: number[]): LabSeries[] => [
  { loinc: "13457-7", name: "LDL cholesterol (calculated)", unit: "mg/dL", refLow: 0, refHigh: 99, values: ldl },
  { loinc: "2085-9", name: "HDL cholesterol", unit: "mg/dL", refLow: 40, refHigh: null, values: hdl },
  { loinc: "2093-3", name: "Cholesterol, total", unit: "mg/dL", refLow: 100, refHigh: 199, values: tc },
  { loinc: "2571-8", name: "Triglycerides", unit: "mg/dL", refLow: 0, refHigh: 149, values: tg }
];
const a1c = (values: number[]): LabSeries => ({ loinc: "4548-4", name: "Hemoglobin A1c", unit: "%", refLow: 4.8, refHigh: 5.6, values });
const glucose = (values: number[]): LabSeries => ({ loinc: "2345-7", name: "Glucose", unit: "mg/dL", refLow: 65, refHigh: 99, values });
const creat = (values: number[]): LabSeries => ({ loinc: "2160-0", name: "Creatinine", unit: "mg/dL", refLow: 0.76, refHigh: 1.27, values });
const ferritin = (values: number[]): LabSeries => ({ loinc: "2276-4", name: "Ferritin", unit: "ng/mL", refLow: 30, refHigh: 400, values });
const tsh = (values: number[]): LabSeries => ({ loinc: "3016-3", name: "TSH", unit: "mIU/L", refLow: 0.45, refHigh: 4.5, values });
const hgb = (values: number[]): LabSeries => ({ loinc: "718-7", name: "Hemoglobin", unit: "g/dL", refLow: 13.0, refHigh: 17.7, values });
const potassium = (values: number[]): LabSeries => ({ loinc: "2823-3", name: "Potassium", unit: "mmol/L", refLow: 3.5, refHigh: 5.2, values });

const LAB_DATES = ["2025-11-20", "2026-02-18", "2026-05-12", "2026-08-25"];

const baseWearable = {
  restingHr: 60, restingHrTrendPerWeek: 0, hrvBase: 50, sleepHours: 7.3, sleepSdMin: 40, hrvPerSleepHour: 4,
  stepsBase: 8000, workoutsPerWeek: 3, napsPerWeek: 0.5, anomalies: [], gaps: [], nonWearDays: []
};

export const PERSONAS: Persona[] = [
  {
    id: "p01", profile: "healthy (trap-rich primary persona)", tz: "America/Los_Angeles", sex: "female", birthDate: "1988-04-17",
    identifiers: { given: "Marisol", family: "Quintrell", mrn: "VG-4471902", email: "marisol.quintrell@example.org", phone: "+1-415-555-0142", street: "1180 Alder Crest Way", city: "Oakhaven" },
    providers: ["oura", "whoop", "apple_health"], hrIntervalMin: 2,
    wearable: {
      ...baseWearable, restingHr: 58, restingHrTrendPerWeek: 0.05, hrvBase: 55, napsPerWeek: 1,
      anomalies: [{ startDay: 200, days: 5, hrDelta: 9, tempDelta: 0.7 }],
      gaps: [{ startDay: 120, days: 6 }], nonWearDays: [40, 41, 250],
      trip: { startDay: 300, days: 12, offsetMinutes: 540 }
    },
    conditions: [
      { name: "Seasonal allergic rhinitis", icd10: "J30.2", snomed: "367498001", onset: "2015", status: "active" },
      { name: "Iron deficiency anemia", icd10: "D50.9", snomed: "87522002", onset: "2025-11-20", status: "resolved" },
      { name: "Migraine without aura", icd10: "G43.009", snomed: "56097005", onset: "2019-05", status: "active" }
    ],
    medications: [
      { name: "cetirizine 10 MG Oral Tablet", rxnorm: "1014676", dosage: "Take 1 tablet by mouth daily as needed", status: "active", authoredOn: "2025-03-02" },
      { name: "ferrous sulfate 325 MG Oral Tablet", dosage: "Take 1 tablet by mouth daily", status: "completed", authoredOn: "2025-11-21" }
    ],
    allergies: [{ substance: "Penicillin", reaction: "Hives", severity: "moderate", criticality: "high" }],
    labDates: LAB_DATES,
    labs: [ferritin([18, 34, 52, 61]), hgb([11.9, 12.8, 13.4, 13.6]), tsh([2.1, 1.9, 2.3, 2.0]), ...lipids([96, 102, 99, 104], [62, 60, 64, 63], [178, 184, 181, 186], [88, 95, 90, 99]), creat([0.8, 0.82, 0.79, 0.81])],
    bp: [{ date: "2025-11-20", systolic: 114, diastolic: 72 }, { date: "2026-05-12", systolic: 118, diastolic: 76 }, { date: "2026-08-25", systolic: 116, diastolic: 74 }],
    familyHistory: [{ relationship: "Mother", condition: "Type 2 diabetes mellitus", onsetAge: 54 }]
  },
  {
    id: "p02", profile: "athlete", tz: "Asia/Kolkata", sex: "male", birthDate: "1994-09-02",
    identifiers: { given: "Devraj", family: "Okonkwo-Lind", mrn: "VG-5530021", email: "devraj.ol@example.net", phone: "+91-98450-55501", street: "42 Lakeview Terrace", city: "Bengaluru" },
    providers: ["whoop", "oura"], hrIntervalMin: 10,
    wearable: { ...baseWearable, restingHr: 46, restingHrTrendPerWeek: -0.03, hrvBase: 85, sleepHours: 7.8, hrvPerSleepHour: 8, stepsBase: 13000, workoutsPerWeek: 6 },
    conditions: [{ name: "Sprain of ankle", icd10: "S93.409A", snomed: "44465007", onset: "2026-03-10", status: "resolved" }],
    medications: [],
    allergies: [],
    labDates: LAB_DATES,
    labs: [hgb([15.8, 15.6, 16.0, 15.9]), ferritin([88, 80, 76, 90]), creat([1.12, 1.18, 1.15, 1.2])],
    bp: [{ date: "2026-02-18", systolic: 112, diastolic: 68 }],
    familyHistory: []
  },
  {
    id: "p03", profile: "sedentary", tz: "Europe/London", sex: "male", birthDate: "1979-01-23",
    identifiers: { given: "Callum", family: "Ferreira-Holt", mrn: "VG-6602117", email: "c.ferreiraholt@example.co.uk", phone: "+44-7700-900417", street: "7 Rowan Mews", city: "Leeds" },
    providers: ["oura"], hrIntervalMin: 10,
    wearable: { ...baseWearable, restingHr: 72, restingHrTrendPerWeek: 0.02, hrvBase: 32, sleepHours: 6.6, stepsBase: 3500, workoutsPerWeek: 0.3 },
    conditions: [{ name: "Obesity", icd10: "E66.9", snomed: "414916001", onset: "2020", status: "active" }],
    medications: [],
    allergies: [],
    labDates: LAB_DATES,
    labs: [...lipids([131, 138, 141, 144], [41, 40, 39, 38], [212, 219, 222, 226], [168, 175, 181, 190]), glucose([98, 101, 103, 104])],
    bp: [{ date: "2026-02-18", systolic: 132, diastolic: 84 }],
    familyHistory: [{ relationship: "Father", condition: "Myocardial infarction", onsetAge: 61 }]
  },
  {
    id: "p04", profile: "recovering from injury", tz: "America/New_York", sex: "female", birthDate: "1985-12-30",
    identifiers: { given: "Annika", family: "Brightwater", mrn: "VG-7713350", email: "annika.b@example.com", phone: "+1-617-555-0199", street: "88 Harbor Lane", city: "Quincy" },
    providers: ["oura"], hrIntervalMin: 10,
    wearable: { ...baseWearable, restingHr: 56, stepsBase: 11000, workoutsPerWeek: 4, injury: { day: 150, days: 60 } },
    conditions: [{ name: "Tear of anterior cruciate ligament of knee", icd10: "S83.511A", snomed: "444448004", onset: "2026-03-29", status: "active" }],
    medications: [{ name: "ibuprofen 400 MG Oral Tablet", rxnorm: "197806", dosage: "Take 1 tablet every 6 hours as needed for pain", status: "completed", authoredOn: "2026-03-29" }],
    allergies: [],
    labDates: LAB_DATES,
    labs: [hgb([13.1, 13.0, 12.6, 13.2]), creat([0.7, 0.72, 0.71, 0.7])],
    bp: [{ date: "2026-03-29", systolic: 121, diastolic: 78 }],
    familyHistory: []
  },
  {
    id: "p05", profile: "hypertension", tz: "America/Chicago", sex: "male", birthDate: "1962-06-11",
    identifiers: { given: "Theodore", family: "Vasquez-Moll", mrn: "VG-8824463", email: "teddy.vm@example.org", phone: "+1-312-555-0175", street: "2201 Prairie Ave", city: "Evanston" },
    providers: ["oura", "apple_health"], hrIntervalMin: 10,
    wearable: { ...baseWearable, restingHr: 68, hrvBase: 30, sleepHours: 6.8, stepsBase: 6000, workoutsPerWeek: 1.5 },
    conditions: [{ name: "Essential hypertension", icd10: "I10", snomed: "59621000", onset: "2018-08", status: "active" }],
    medications: [
      { name: "amlodipine 5 MG Oral Tablet", rxnorm: "197361", dosage: "Take 1 tablet by mouth once daily", status: "active", authoredOn: "2024-01-09" },
      { name: "lisinopril 10 MG Oral Tablet", rxnorm: "314076", dosage: "Take 1 tablet by mouth once daily", status: "stopped", authoredOn: "2019-02-01" }
    ],
    allergies: [{ substance: "Sulfonamide antibiotics", reaction: "Rash", severity: "mild", criticality: "low" }],
    labDates: LAB_DATES,
    labs: [potassium([4.2, 4.5, 4.4, 4.6]), creat([1.1, 1.14, 1.2, 1.22]), ...lipids([118, 115, 121, 117], [48, 47, 49, 48], [196, 192, 199, 195], [140, 132, 151, 144])],
    bp: [
      { date: "2025-11-20", systolic: 148, diastolic: 94 }, { date: "2026-02-18", systolic: 142, diastolic: 90 },
      { date: "2026-05-12", systolic: 136, diastolic: 86 }, { date: "2026-08-25", systolic: 131, diastolic: 84 }
    ],
    familyHistory: [{ relationship: "Father", condition: "Stroke", onsetAge: 70 }]
  },
  {
    id: "p06", profile: "type 2 diabetes", tz: "Asia/Dubai", sex: "female", birthDate: "1970-02-14",
    identifiers: { given: "Leilani", family: "Achterberg", mrn: "VG-9935574", email: "leilani.achterberg@example.ae", phone: "+971-50-555-0133", street: "Villa 12, Palm Grove St", city: "Dubai" },
    providers: ["oura"], hrIntervalMin: 10,
    wearable: { ...baseWearable, restingHr: 70, hrvBase: 28, sleepHours: 6.9, stepsBase: 5200 },
    conditions: [{ name: "Type 2 diabetes mellitus without complications", icd10: "E11.9", snomed: "44054006", onset: "2017-03-03", status: "active" }],
    medications: [{ name: "metformin hydrochloride 500 MG Oral Tablet", rxnorm: "861007", dosage: "Take 1 tablet by mouth twice daily with meals", status: "active", authoredOn: "2017-03-03" }],
    allergies: [],
    labDates: LAB_DATES,
    labs: [a1c([8.1, 7.6, 7.2, 6.9]), glucose([162, 148, 139, 131]), creat([0.9, 0.92, 0.95, 0.94])],
    bp: [{ date: "2026-05-12", systolic: 128, diastolic: 80 }],
    familyHistory: [{ relationship: "Sister", condition: "Type 2 diabetes mellitus", onsetAge: 48 }]
  },
  {
    id: "p07", profile: "high cholesterol", tz: "Europe/Berlin", sex: "male", birthDate: "1968-10-05",
    identifiers: { given: "Gregor", family: "Halvorsen-Pike", mrn: "VG-1046685", email: "g.halvorsenpike@example.de", phone: "+49-151-5550-1186", street: "Kastanienallee 54", city: "Potsdam" },
    providers: ["oura", "whoop"], hrIntervalMin: 10,
    wearable: { ...baseWearable, restingHr: 64, hrvBase: 38 },
    conditions: [{ name: "Pure hypercholesterolemia", icd10: "E78.00", snomed: "267432004", onset: "2023-06", status: "active" }],
    medications: [{ name: "atorvastatin 20 MG Oral Tablet", rxnorm: "617310", dosage: "Take 1 tablet by mouth at bedtime", status: "active", authoredOn: "2023-07-11" }],
    allergies: [],
    labDates: LAB_DATES,
    labs: [...lipids([168, 131, 112, 104], [44, 46, 47, 48], [251, 214, 196, 188], [190, 170, 160, 152]), creat([1.0, 1.02, 0.99, 1.01])],
    bp: [{ date: "2026-02-18", systolic: 126, diastolic: 82 }],
    familyHistory: [{ relationship: "Father", condition: "Coronary artery disease", onsetAge: 58 }]
  },
  {
    id: "p08", profile: "anxiety or depression", tz: "Pacific/Tongatapu", sex: "female", birthDate: "1991-07-29",
    identifiers: { given: "Saia", family: "Moengangongo-Reid", mrn: "VG-2157796", email: "saia.mr@example.to", phone: "+676-555-0109", street: "15 Taufa'ahau Road", city: "Nuku'alofa" },
    providers: ["oura"], hrIntervalMin: 10,
    wearable: { ...baseWearable, restingHr: 66, hrvBase: 34, sleepHours: 6.4, sleepSdMin: 60, hrvPerSleepHour: 6, napsPerWeek: 2 },
    conditions: [{ name: "Generalized anxiety disorder", icd10: "F41.1", snomed: "21897009", onset: "2022", status: "active" }],
    medications: [{ name: "sertraline 50 MG Oral Tablet", rxnorm: "312940", dosage: "Take 1 tablet by mouth daily", status: "active", authoredOn: "2024-11-02" }],
    allergies: [],
    labDates: LAB_DATES,
    labs: [tsh([1.6, 1.7, 1.5, 1.8]), hgb([12.9, 13.1, 13.0, 13.2])],
    bp: [{ date: "2026-05-12", systolic: 112, diastolic: 70 }],
    familyHistory: []
  },
  {
    id: "p09", profile: "respiratory condition", tz: "America/Denver", sex: "male", birthDate: "1983-03-19",
    identifiers: { given: "Ezekiel", family: "Thornbury-Nakamura", mrn: "VG-3268807", email: "zeke.tn@example.com", phone: "+1-303-555-0166", street: "640 Aspen Ridge Rd", city: "Boulder" },
    providers: ["oura", "apple_health"], hrIntervalMin: 10,
    wearable: { ...baseWearable, restingHr: 63, hrvBase: 44, anomalies: [{ startDay: 90, days: 7, hrDelta: 7, tempDelta: 0.5 }, { startDay: 280, days: 4, hrDelta: 6, tempDelta: 0.4 }] },
    conditions: [{ name: "Mild persistent asthma", icd10: "J45.30", snomed: "426979002", onset: "2009", status: "active" }],
    medications: [
      { name: "albuterol 0.09 MG/ACTUAT Metered Dose Inhaler", rxnorm: "745679", dosage: "Inhale 2 puffs every 4-6 hours as needed", status: "active", authoredOn: "2025-09-01" },
      { name: "fluticasone propionate 0.11 MG/ACTUAT Inhaler", rxnorm: "896188", dosage: "Inhale 2 puffs twice daily", status: "active", authoredOn: "2025-09-01" }
    ],
    allergies: [{ substance: "Aspirin", reaction: "Bronchospasm", severity: "severe", criticality: "high" }],
    labDates: LAB_DATES,
    labs: [hgb([15.1, 14.9, 15.2, 15.0])],
    bp: [{ date: "2026-02-18", systolic: 122, diastolic: 78 }],
    familyHistory: []
  },
  {
    id: "p10", profile: "cardiovascular disease", tz: "Australia/Sydney", sex: "male", birthDate: "1956-11-08",
    identifiers: { given: "Bartholomew", family: "Kingsley-Oduya", mrn: "VG-4379918", email: "bart.ko@example.com.au", phone: "+61-412-555-018", street: "3 Jacaranda Close", city: "Parramatta" },
    providers: ["oura", "whoop"], hrIntervalMin: 10,
    wearable: { ...baseWearable, restingHr: 66, restingHrTrendPerWeek: 0.08, hrvBase: 26, sleepHours: 6.7, trip: { startDay: 220, days: 18, offsetMinutes: -420 } },
    conditions: [
      { name: "Coronary arteriosclerosis", icd10: "I25.10", snomed: "53741008", onset: "2021-04-12", status: "active" },
      { name: "Old myocardial infarction", icd10: "I25.2", snomed: "1755008", onset: "2021-04", status: "active" }
    ],
    medications: [
      { name: "aspirin 81 MG Oral Tablet", rxnorm: "243670", dosage: "Take 1 tablet by mouth daily", status: "active", authoredOn: "2021-04-15" },
      { name: "metoprolol succinate 25 MG Extended Release Oral Tablet", rxnorm: "866427", dosage: "Take 1 tablet by mouth daily", status: "active", authoredOn: "2021-04-15" },
      { name: "rosuvastatin 20 MG Oral Tablet", rxnorm: "859751", dosage: "Take 1 tablet by mouth daily", status: "active", authoredOn: "2021-04-15" }
    ],
    allergies: [],
    labDates: LAB_DATES,
    labs: [
      ...lipids([74, 69, 71, 66], [42, 43, 41, 44], [150, 146, 149, 143], [130, 122, 128, 118]),
      { loinc: "6598-7", name: "Troponin T, cardiac", unit: "ng/mL", refLow: 0, refHigh: 0.01, values: [0.005, 0.006, 0.005, 0.24], criticalLast: "HH" },
      potassium([4.4, 4.3, 4.6, 4.5])
    ],
    bp: [{ date: "2025-11-20", systolic: 128, diastolic: 78 }, { date: "2026-08-25", systolic: 124, diastolic: 76 }],
    familyHistory: [{ relationship: "Brother", condition: "Coronary artery disease", onsetAge: 63 }]
  }
];

export function persona(id: string): Persona {
  const p = PERSONAS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown persona ${id}`);
  return p;
}

export function evalDbName(id: string): string {
  return `ayuos_eval_${id}`;
}
