import { describe, expect, it } from "vitest";
import { parseContractUpdate } from "./contractUpdate.js";

describe("parseContractUpdate", () => {
  it("marks won contracts as settled", () => {
    const update = parseContractUpdate({
      contract_id: 123,
      status: "won",
      buy_price: 10,
      payout: 19.23,
      profit: 9.23,
      entry_spot: 1000.5,
      exit_tick: 1001.2
    });
    expect(update).toMatchObject({
      contractId: "123",
      status: "won",
      isSettled: true,
      profit: 9.23,
      payout: 19.23
    });
  });

  it("marks lost contracts as settled", () => {
    const update = parseContractUpdate({
      contract_id: 456,
      status: "lost",
      buy_price: 10,
      profit: -10
    });
    expect(update.isSettled).toBe(true);
    expect(update.status).toBe("lost");
  });

  it("keeps open contracts unsettled", () => {
    const update = parseContractUpdate({
      contract_id: 789,
      status: "open",
      buy_price: 1,
      is_sold: 0,
      is_settleable: 1
    });
    expect(update.isSettled).toBe(false);
    expect(update.status).toBe("open");
  });
});
