import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const eaPath = join(here, "../ea/RegimeXExec.mq5");

describe("RegimeXExec.mq5 history enumeration", () => {
  const src = readFileSync(eaPath, "utf8");

  function extractFunction(name: string): string {
    const start = src.indexOf(`string ${name}(`) >= 0 ? src.indexOf(`string ${name}(`) : src.indexOf(`void ${name}(`);
    expect(start).toBeGreaterThan(-1);
    // Find matching closing brace of the function body (first `{` after signature).
    const brace = src.indexOf("{", start);
    let depth = 0;
    for (let i = brace; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    throw new Error(`Could not extract ${name}`);
  }

  it("SymbolJson exposes stopsLevel and freezeLevel alongside point/tickSize", () => {
    const body = extractFunction("SymbolJson");
    expect(body).toContain("SYMBOL_TRADE_STOPS_LEVEL");
    expect(body).toContain("SYMBOL_TRADE_FREEZE_LEVEL");
    expect(body).toContain('\\"stopsLevel\\"');
    expect(body).toContain('\\"freezeLevel\\"');
    expect(body).toContain('\\"point\\"');
    expect(body).toContain('\\"tickSize\\"');
  });

  it("HandleModify fail-closes when price is inside freeze level", () => {
    const body = extractFunction("HandleModify");
    expect(body).toContain("SYMBOL_TRADE_FREEZE_LEVEL");
    expect(body).toContain("MT5_PRICE_IN_FREEZE_LEVEL");
  });

  it("DealJson does not call HistoryDealSelect (avoids mutating HistorySelect set)", () => {
    const body = extractFunction("DealJson");
    expect(body).not.toContain("HistoryDealSelect");
    expect(body).toContain("HistoryDealGetInteger(ticket");
    expect(body).toContain("HistoryDealGetDouble(ticket");
    expect(body).toContain("HistoryDealGetString(ticket");
    expect(body).toContain('\\"dealTicket\\"');
    expect(body).toContain('\\"positionTicket\\"');
    expect(body).toContain('\\"entry\\"');
    expect(body).toContain('\\"reasonRaw\\"');
  });

  it("HandleHistory iterates HistorySelect without HistoryDealSelect in the loop", () => {
    const body = extractFunction("HandleHistory");
    expect(body).toContain("HistorySelect(from, to)");
    expect(body).toContain("HistoryDealsTotal()");
    expect(body).toContain("HistoryDealGetTicket(i)");
    expect(body).toContain("if(ticket == 0)");
    expect(body).not.toMatch(/HistoryDealSelect\s*\(/);
    expect(body).toContain("DealJson(ticket)");
    expect(body).toMatch(/HistoryDealSelect must NOT be called|Never call HistoryDealSelect/i);
  });

  it("preserves single-deal HistoryDealSelect only outside history iteration", () => {
    const openBody = extractFunction("HandleOpen");
    const closeBody = extractFunction("HandleClose");
    expect(openBody).toContain("HistoryDealSelect(res.deal)");
    expect(closeBody).toContain("HistoryDealSelect(res.deal)");
    // Ensure they are not iterating a HistorySelect index set.
    expect(openBody).not.toContain("HistoryDealGetTicket");
    expect(closeBody).not.toContain("HistoryDealGetTicket");
    expect(openBody).not.toMatch(/HistoryDealsTotal\s*\(/);
    expect(closeBody).not.toMatch(/HistoryDealsTotal\s*\(/);
  });
});
