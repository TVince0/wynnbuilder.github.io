import { gpuProcess } from "./process.mjs";
const child = gpuProcess([
  process.argv.includes("--compile-only") ? "--compile-only" : "--probe",
]);
try {
  console.log(JSON.stringify(await child.receive(), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  child.close();
}
