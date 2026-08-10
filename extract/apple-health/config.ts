export interface AppleHealthConfig {
  exportPath: string;
  fhirConverterUrl: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadAppleHealthConfig(): AppleHealthConfig {
  return {
    exportPath: requiredEnv("APPLE_HEALTH_EXPORT_PATH"),
    fhirConverterUrl:
      process.env.FHIR_CONVERTER_URL?.trim() || "http://127.0.0.1:8080"
  };
}
