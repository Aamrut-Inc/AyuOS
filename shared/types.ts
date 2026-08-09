export interface FhirResource {
  resourceType: string;
  id?: string;
  [key: string]: unknown;
}
