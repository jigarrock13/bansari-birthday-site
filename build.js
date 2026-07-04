const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const root = __dirname;
const chunkDir = path.join(root, "deploy-bundle");
const overridesDir = path.join(root, "deploy-overrides");
let chunks = fs
  .readdirSync(chunkDir)
  .filter((name) => /^chunk-\d+\.txt$/.test(name))
  .sort()
  .map((name) => fs.readFileSync(path.join(chunkDir, name), "utf8"))
  .join("")
  .replace(/\s+/g, "");

const knownChunkRepair = "IzPVwMbps3GV8gvzu17mRfEAuA";
if (chunks.includes(knownChunkRepair)) {
  chunks = chunks.replace(knownChunkRepair, "IzPVwPbsMbps3GV8gvzu17mRfEAuA");
  console.log("Applied deployment bundle chunk repair.");
}

const payload = JSON.parse(zlib.gunzipSync(Buffer.from(chunks, "base64")).toString("utf8"));

for (const file of payload.files) {
  const target = path.join(root, file.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(file.content, "base64"));
}

function copyOverrides(sourceDir, relativeDir = "") {
  if (!fs.existsSync(sourceDir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      count += copyOverrides(source, relativePath);
    } else {
      const target = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      count += 1;
    }
  }
  return count;
}

const overrideCount = copyOverrides(overridesDir);
if (overrideCount) console.log(`Applied ${overrideCount} deployment override files.`);

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";

if (process.env.VERCEL && (!supabaseUrl || !supabaseAnonKey)) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in Vercel environment variables.");
  process.exit(1);
}

const runtimeConfig = `window.BANSARI_RUNTIME_CONFIG = ${JSON.stringify(
  { supabaseUrl, supabaseAnonKey },
  null,
  2
)};\n`;

fs.writeFileSync(path.join(root, "runtime-config.js"), runtimeConfig, "utf8");
console.log(`Unpacked ${payload.files.length} site files and wrote runtime-config.js.`);

if (process.env.VERCEL) {
  fs.rmSync(chunkDir, { recursive: true, force: true });
  fs.rmSync(overridesDir, { recursive: true, force: true });
}
