import { expect, test } from "bun:test";
import { directoryHospitals, findDirectoryHospital } from "./hospital-pages";

test("the directory includes the sandbox first and real health systems after", () => {
  const all = directoryHospitals();
  expect(all[0].sandbox).toBe(true);
  expect(all.length).toBeGreaterThan(400);
  expect(findDirectoryHospital("https://sfd.stanfordmed.org/FHIR/api/FHIR/R4/")?.name).toBe("Stanford Health Care");
  expect(findDirectoryHospital("https://not-a-hospital.example.com")).toBeNull();
});
