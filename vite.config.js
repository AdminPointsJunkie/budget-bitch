import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const extractor = fileURLToPath(new URL("./scripts/extract_pdf.py", import.meta.url));

function localPdfReader() {
  return {
    name: "local-pdf-reader",
    configureServer(server) {
      server.middlewares.use("/api/parse-pdf", (req, res, next) => {
        if (req.method !== "POST") return next();
        const chunks = [];
        let size = 0;
        req.on("data", chunk => {
          size += chunk.length;
          if (size > 30 * 1024 * 1024) req.destroy();
          else chunks.push(chunk);
        });
        req.on("end", () => {
          const child = spawn("python3", [extractor], { stdio:["pipe","pipe","pipe"] });
          const output = [], errors = [];
          child.stdout.on("data", chunk => output.push(chunk));
          child.stderr.on("data", chunk => errors.push(chunk));
          child.on("close", code => {
            res.setHeader("Content-Type", "application/json");
            if (code !== 0) {
              res.statusCode = 422;
              res.end(JSON.stringify({error:Buffer.concat(errors).toString().trim() || "Unable to read PDF"}));
            } else res.end(Buffer.concat(output));
          });
          child.stdin.end(Buffer.concat(chunks));
        });
      });
    }
  };
}

export default defineConfig({
  plugins:[react(), localPdfReader()]
});
