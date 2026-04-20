import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";

const DEFAULT_B = 900;
const PRE_GAME_MULTIPLIER = 0.75;
const INITIAL_USER_BALANCE = 1000;
const USER_COUNT = 7;
const OUTCOMES = ["RCB", "CSK"] as const;
type Outcome = (typeof OUTCOMES)[number];
type PriceFeeTier = { maxPrice: number; baseRate: number };

const PRICE_FEE_TIERS: PriceFeeTier[] = [
  { maxPrice: 0.3, baseRate: 0.005 },
  { maxPrice: 0.6, baseRate: 0.01 },
  { maxPrice: 0.8, baseRate: 0.02 },
  { maxPrice: 0.9, baseRate: 0.025 },
  { maxPrice: Number.POSITIVE_INFINITY, baseRate: 0.03 }
];

type User = {
  id: string;
  balance: number;
  holdings: Record<Outcome, number>;
};

type TradeRecord = {
  timestamp: string;
  userId: string;
  outcome: Outcome;
  quantity: number;
  cost: number;
  fee: number;
  priceAfterTrade: Record<Outcome, number>;
};

type ResolveRecord = {
  winner: Outcome;
  payouts: Array<{ userId: string; payout: number }>;
  marketMakerProfitLoss: number;
};

type MarketState = {
  totalShares: Record<Outcome, number>;
  tradeHistory: TradeRecord[];
  resolveRecord: ResolveRecord | null;
  users: User[];
};

function getLiquidityParameter(): number {
  const raw = process.env.LMSR_B;
  if (!raw) {
    return DEFAULT_B;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.log(`Invalid LMSR_B value "${raw}". Falling back to ${DEFAULT_B}.`);
    return DEFAULT_B;
  }

  return parsed;
}

class LMSRMarket {
  private readonly b: number;
  private readonly users: Map<string, User>;
  private readonly totalShares: Record<Outcome, number>;
  private readonly tradeHistory: TradeRecord[];
  private resolveRecord: ResolveRecord | null;
  private readonly stateFilePath: string;
  private gameStartTimestamp: number | null;

  constructor(b: number) {
    this.b = b;
    this.totalShares = { RCB: 0, CSK: 0 };
    this.tradeHistory = [];
    this.resolveRecord = null;
    this.gameStartTimestamp = null;
    this.users = new Map<string, User>();
    this.stateFilePath = path.resolve(process.cwd(), "market-state.json");
    this.loadStateOrInitialize();
  }

  private initializeUsers(): User[] {
    const users: User[] = [];
    for (let i = 1; i <= USER_COUNT; i += 1) {
      const userId = `U${i}`;
      users.push({
        id: userId,
        balance: INITIAL_USER_BALANCE,
        holdings: { RCB: 0, CSK: 0 }
      });
    }
    return users;
  }

  private loadStateOrInitialize(): void {
    if (fs.existsSync(this.stateFilePath)) {
      try {
        const raw = fs.readFileSync(this.stateFilePath, "utf-8");
        const parsed = JSON.parse(raw) as MarketState;
        this.totalShares.RCB = parsed.totalShares.RCB;
        this.totalShares.CSK = parsed.totalShares.CSK;
        this.tradeHistory.push(...parsed.tradeHistory);
        this.resolveRecord = parsed.resolveRecord;
        for (const user of parsed.users) {
          this.users.set(user.id, user);
        }
        return;
      } catch (error) {
        console.log("State file is invalid. Starting with a fresh market.");
      }
    }

    const initialUsers = this.initializeUsers();
    for (const user of initialUsers) {
      this.users.set(user.id, user);
    }
    this.persistState();
  }

  private persistState(): void {
    const state: MarketState = {
      totalShares: { ...this.totalShares },
      tradeHistory: [...this.tradeHistory],
      resolveRecord: this.resolveRecord,
      users: Array.from(this.users.values())
    };
    fs.writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2));
  }

  private getPriceBaseRate(price: number): number {
    for (const tier of PRICE_FEE_TIERS) {
      if (price <= tier.maxPrice) {
        return tier.baseRate;
      }
    }

    return PRICE_FEE_TIERS[PRICE_FEE_TIERS.length - 1].baseRate;
  }

  private getInGameHourNumber(nowMs = Date.now()): number {
    if (!this.gameStartTimestamp) {
      return 1;
    }

    const elapsedMs = Math.max(0, nowMs - this.gameStartTimestamp);
    const elapsedHours = elapsedMs / (60 * 60 * 1000);
    if (elapsedHours < 1) {
      return 1;
    }
    if (elapsedHours < 2) {
      return 2;
    }
    if (elapsedHours < 3) {
      return 3;
    }
    return 4;
  }

  private getTimeMultiplier(hourNumber: number): number {
    if (hourNumber <= 1) {
      return 1.0;
    }
    if (hourNumber === 2) {
      return 1.5;
    }
    if (hourNumber === 3) {
      return 2.5;
    }
    return 4.0;
  }

  private getTradeFeeRate(outcomePrice: number, nowMs = Date.now()): number {
    const baseRate = this.getPriceBaseRate(outcomePrice);
    if (!this.gameStartTimestamp) {
      return baseRate * PRE_GAME_MULTIPLIER;
    }

    const hourNumber = this.getInGameHourNumber(nowMs);
    const multiplier = this.getTimeMultiplier(hourNumber);
    return baseRate * multiplier;
  }

  private formatFeeRate(rate: number): string {
    return `${(rate * 100).toFixed(2)}%`;
  }

  startGame(): { success: boolean; message: string } {
    if (this.resolveRecord) {
      return { success: false, message: "Cannot start game after market resolution." };
    }
    if (this.gameStartTimestamp) {
      return { success: false, message: "Game already started." };
    }

    this.gameStartTimestamp = Date.now();
    return { success: true, message: "Game started. Time-based fee multipliers are now active." };
  }

  private getLogSumExp(shares: Record<Outcome, number>): number {
    const scaled = OUTCOMES.map((outcome) => shares[outcome] / this.b);
    const maxScaled = Math.max(...scaled);
    const expSum = scaled.reduce((sum, value) => sum + Math.exp(value - maxScaled), 0);
    return maxScaled + Math.log(expSum);
  }

  getPoolCost(shares: Record<Outcome, number>): number {
    return this.b * this.getLogSumExp(shares);
  }

  getCurrentPoolCost(): number {
    return this.getPoolCost(this.totalShares);
  }

  getTotalFeesCollected(): number {
    return this.tradeHistory.reduce((sum, trade) => sum + (trade.fee ?? 0), 0);
  }

  getPrices(): Record<Outcome, number> {
    const logDenominator = this.getLogSumExp(this.totalShares);

    return {
      RCB: Math.exp(this.totalShares.RCB / this.b - logDenominator),
      CSK: Math.exp(this.totalShares.CSK / this.b - logDenominator)
    };
  }

  getTradeQuote(outcome: Outcome, quantity: number): { success: boolean; message: string; cost?: number } {
    if (this.resolveRecord) {
      return { success: false, message: "Market is already resolved. No further trades allowed." };
    }

    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { success: false, message: "Quantity must be a positive number." };
    }

    const currentCost = this.getCurrentPoolCost();
    const newShares = { ...this.totalShares, [outcome]: this.totalShares[outcome] + quantity };
    const newCost = this.getPoolCost(newShares);
    const costToUser = newCost - currentCost;
    const avgPricePerShare = costToUser / quantity;

    return {
      success: true,
      cost: costToUser,
      message: `Quote -> Buy ${quantity} ${outcome}: Cost $${costToUser.toFixed(2)} (avg $${avgPricePerShare.toFixed(4)} / share)`
    };
  }

  getSellQuote(userId: string, outcome: Outcome, quantity: number): { success: boolean; message: string; payout?: number } {
    if (this.resolveRecord) {
      return { success: false, message: "Market is already resolved. No further trades allowed." };
    }

    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { success: false, message: "Quantity must be a positive number." };
    }

    const user = this.users.get(userId);
    if (!user) {
      return { success: false, message: `User ${userId} not found.` };
    }

    if (user.holdings[outcome] < quantity) {
      return {
        success: false,
        message: `Insufficient holdings. You have ${user.holdings[outcome].toFixed(2)} ${outcome} shares.`
      };
    }

    const currentCost = this.getCurrentPoolCost();
    const newShares = { ...this.totalShares, [outcome]: this.totalShares[outcome] - quantity };
    const newCost = this.getPoolCost(newShares);
    const payoutToUser = currentCost - newCost;
    const avgPricePerShare = payoutToUser / quantity;

    return {
      success: true,
      payout: payoutToUser,
      message: `Quote -> Sell ${quantity} ${outcome}: Receive $${payoutToUser.toFixed(2)} (avg $${avgPricePerShare.toFixed(
        4
      )} / share)`
    };
  }

  executeTrade(userId: string, outcome: Outcome, quantity: number): { success: boolean; message: string } {
    if (this.resolveRecord) {
      return { success: false, message: "Market is already resolved. No further trades allowed." };
    }

    const user = this.users.get(userId);
    if (!user) {
      return { success: false, message: `User ${userId} not found.` };
    }

    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { success: false, message: "Quantity must be a positive number." };
    }

    const currentCost = this.getCurrentPoolCost();
    const newShares = { ...this.totalShares, [outcome]: this.totalShares[outcome] + quantity };
    const newCost = this.getPoolCost(newShares);
    const grossCost = newCost - currentCost;
    const pricesBeforeTrade = this.getPrices();
    const feeRate = this.getTradeFeeRate(pricesBeforeTrade[outcome]);
    const fee = grossCost * feeRate;
    const totalCostToUser = grossCost + fee;

    if (user.balance < totalCostToUser) {
      return {
        success: false,
        message: `Insufficient balance. Trade cost + fee: $${totalCostToUser.toFixed(2)}, Available: $${user.balance.toFixed(
          2
        )}`
      };
    }

    user.balance -= totalCostToUser;
    user.holdings[outcome] += quantity;
    this.totalShares[outcome] += quantity;

    const pricesAfterTrade = this.getPrices();
    this.tradeHistory.push({
      timestamp: new Date().toISOString(),
      userId,
      outcome,
      quantity,
      cost: totalCostToUser,
      fee,
      priceAfterTrade: pricesAfterTrade
    });
    this.persistState();

    return {
      success: true,
      message: `Trade executed. ${userId} bought ${quantity} ${outcome} shares | Gross: $${grossCost.toFixed(
        2
      )}, Fee (${this.formatFeeRate(feeRate)}): $${fee.toFixed(2)}, Total: $${totalCostToUser.toFixed(2)}`
    };
  }

  executeSell(userId: string, outcome: Outcome, quantity: number): { success: boolean; message: string } {
    if (this.resolveRecord) {
      return { success: false, message: "Market is already resolved. No further trades allowed." };
    }

    const user = this.users.get(userId);
    if (!user) {
      return { success: false, message: `User ${userId} not found.` };
    }

    const quote = this.getSellQuote(userId, outcome, quantity);
    if (!quote.success || quote.payout === undefined) {
      return { success: false, message: quote.message };
    }

    const grossPayout = quote.payout;
    const pricesBeforeTrade = this.getPrices();
    const feeRate = this.getTradeFeeRate(pricesBeforeTrade[outcome]);
    const fee = grossPayout * feeRate;
    const netPayout = grossPayout - fee;

    user.balance += netPayout;
    user.holdings[outcome] -= quantity;
    this.totalShares[outcome] -= quantity;

    const pricesAfterTrade = this.getPrices();
    this.tradeHistory.push({
      timestamp: new Date().toISOString(),
      userId,
      outcome,
      quantity: -quantity,
      cost: -netPayout,
      fee,
      priceAfterTrade: pricesAfterTrade
    });
    this.persistState();

    return {
      success: true,
      message: `Trade executed. ${userId} sold ${quantity} ${outcome} shares | Gross: $${grossPayout.toFixed(
        2
      )}, Fee (${this.formatFeeRate(feeRate)}): $${fee.toFixed(2)}, Net: $${netPayout.toFixed(2)}`
    };
  }

  resolve(winner: Outcome): { success: boolean; message: string } {
    if (this.resolveRecord) {
      return { success: false, message: "Market already resolved." };
    }

    const payouts: Array<{ userId: string; payout: number }> = [];
    for (const user of this.users.values()) {
      const payout = user.holdings[winner];
      user.balance += payout;
      payouts.push({ userId: user.id, payout });
    }

    const totalCollected = this.tradeHistory.reduce((sum, t) => sum + t.cost, 0);
    const totalPayout = payouts.reduce((sum, p) => sum + p.payout, 0);
    const marketMakerProfitLoss = totalCollected - totalPayout;

    this.resolveRecord = {
      winner,
      payouts,
      marketMakerProfitLoss
    };
    this.persistState();

    return {
      success: true,
      message: `Market resolved: ${winner} wins. Winner price set to 1.00, loser price set to 0.00`
    };
  }

  printScoreboard(): void {
    const prices = this.resolveRecord
      ? ({
          RCB: this.resolveRecord.winner === "RCB" ? 1 : 0,
          CSK: this.resolveRecord.winner === "CSK" ? 1 : 0
        } as Record<Outcome, number>)
      : this.getPrices();

    console.log("\n===== SCOREBOARD =====");
    console.log(
      `Game Status: ${this.gameStartTimestamp ? `IN-GAME (hour ${this.getInGameHourNumber()})` : "PRE-GAME (0.75x of hour-1 price base fee)"}`
    );
    console.log(`Prices -> P(RCB): ${prices.RCB.toFixed(4)} | P(CSK): ${prices.CSK.toFixed(4)}`);
    console.log(`Total Shares -> RCB: ${this.totalShares.RCB.toFixed(2)} | CSK: ${this.totalShares.CSK.toFixed(2)}`);
    console.log(`Total Fees Collected: $${this.getTotalFeesCollected().toFixed(2)}`);
    console.log("----------------------");
    console.log("User Balances & Holdings:");

    for (const user of this.users.values()) {
      console.log(
        `${user.id} | Balance: $${user.balance.toFixed(2)} | Holdings -> RCB: ${user.holdings.RCB.toFixed(
          2
        )}, CSK: ${user.holdings.CSK.toFixed(2)}`
      );
    }

    if (this.resolveRecord) {
      console.log("----------------------");
      console.log(`Resolved Winner: ${this.resolveRecord.winner}`);
      console.log(`Market Maker P/L (Subsidizer): $${this.resolveRecord.marketMakerProfitLoss.toFixed(2)}`);
    }

    console.log("======================\n");
  }

  printFeeTable(): void {
    console.log("\n===== FEE TABLE =====");
    console.log("| Price Range | Pre-Game (0.75x H1) | Hour 1 (1.0x) | Hour 2 (1.5x) | Hour 3 (2.5x) | Hour 4+ (4.0x) |");
    console.log("|-------------|----------------------|---------------|---------------|---------------|----------------|");
    console.log("| Price <= 0.30 | 0.375% | 0.50% | 0.75% | 1.25% | 2.00% |");
    console.log("| 0.30 < Price <= 0.60 | 0.75% | 1.00% | 1.50% | 2.50% | 4.00% |");
    console.log("| 0.60 < Price <= 0.80 | 1.50% | 2.00% | 3.00% | 5.00% | 8.00% |");
    console.log("| 0.80 < Price <= 0.90 | 1.875% | 2.50% | 3.75% | 6.25% | 10.00% |");
    console.log("| Price > 0.90 | 2.25% | 3.00% | 4.50% | 7.50% | 12.00% |");
    console.log("=====================\n");
  }

  printTradeHistory(): void {
    if (this.tradeHistory.length === 0) {
      console.log("No trades yet.");
      return;
    }

    console.log("\n===== TRADE HISTORY =====");
    for (const trade of this.tradeHistory) {
      const action = trade.quantity >= 0 ? "bought" : "sold";
      const absQuantity = Math.abs(trade.quantity);
      const absCost = Math.abs(trade.cost);
      const fee = trade.fee ?? 0;
      console.log(
        `${trade.timestamp} | ${trade.userId} ${action} ${absQuantity} ${trade.outcome} | ${action === "bought" ? "Cost" : "Payout"}: $${absCost.toFixed(
          2
        )} | Fee: $${fee.toFixed(2)} | Post Price -> RCB: ${trade.priceAfterTrade.RCB.toFixed(4)}, CSK: ${trade.priceAfterTrade.CSK.toFixed(4)}`
      );
    }
    console.log("=========================\n");
  }

  resetMarket(): void {
    this.totalShares.RCB = 0;
    this.totalShares.CSK = 0;
    this.tradeHistory.length = 0;
    this.resolveRecord = null;
    this.gameStartTimestamp = null;
    this.users.clear();
    for (const user of this.initializeUsers()) {
      this.users.set(user.id, user);
    }
    this.persistState();
  }

  printHelp(): void {
    console.log("\nCommands:");
    console.log("  trade <USER_ID> <RCB|CSK> <QUANTITY>   e.g., trade U1 RCB 10");
    console.log("  sell <USER_ID> <RCB|CSK> <QUANTITY>    e.g., sell U1 RCB 5");
    console.log("  quote <QUANTITY>                        show buy quote for both outcomes");
    console.log("  quote <RCB|CSK> <QUANTITY>              show buy quote for one outcome");
    console.log("  quote sell <USER_ID> <RCB|CSK> <QTY>    show sell quote for one outcome");
    console.log("  start                                   start in-game timer for fee multipliers");
    console.log("  fee-table                               show current fee structure");
    console.log("  resolve <RCB|CSK>                       e.g., resolve CSK");
    console.log("  reset                                   clear state and start new market");
    console.log("  scoreboard                              show current market state");
    console.log("  history                                 show all trades");
    console.log("  help                                    show commands");
    console.log("  exit                                    quit");
    console.log("");
  }
}

function parseOutcome(input: string): Outcome | null {
  const normalized = input.trim().toUpperCase();
  if (normalized === "RCB" || normalized === "CSK") {
    return normalized;
  }
  return null;
}

function bootstrap(): void {
  const liquidityParameter = getLiquidityParameter();
  const market = new LMSRMarket(liquidityParameter);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "lmsr> "
  });

  console.log("LMSR Prediction Market (RCB vs CSK)");
  console.log(`Liquidity parameter b = ${liquidityParameter}`);
  console.log(`Initialized ${USER_COUNT} users with $${INITIAL_USER_BALANCE} balance each.`);
  market.printScoreboard();
  market.printHelp();

  rl.prompt();

  rl.on("line", (line: string) => {
    const args = line.trim().split(/\s+/).filter(Boolean);
    if (args.length === 0) {
      rl.prompt();
      return;
    }

    const command = args[0].toLowerCase();

    switch (command) {
      case "trade": {
        if (args.length !== 4) {
          console.log("Usage: trade <USER_ID> <RCB|CSK> <QUANTITY>");
          break;
        }

        const userId = args[1].toUpperCase();
        const outcome = parseOutcome(args[2]);
        const quantity = Number(args[3]);

        if (!outcome) {
          console.log("Outcome must be RCB or CSK.");
          break;
        }

        const quote = market.getTradeQuote(outcome, quantity);
        console.log(quote.message);
        if (!quote.success) {
          break;
        }

        const result = market.executeTrade(userId, outcome, quantity);
        console.log(result.message);
        market.printScoreboard();
        break;
      }
      case "sell": {
        if (args.length !== 4) {
          console.log("Usage: sell <USER_ID> <RCB|CSK> <QUANTITY>");
          break;
        }

        const userId = args[1].toUpperCase();
        const outcome = parseOutcome(args[2]);
        const quantity = Number(args[3]);

        if (!outcome) {
          console.log("Outcome must be RCB or CSK.");
          break;
        }

        const quote = market.getSellQuote(userId, outcome, quantity);
        console.log(quote.message);
        if (!quote.success) {
          break;
        }

        const result = market.executeSell(userId, outcome, quantity);
        console.log(result.message);
        market.printScoreboard();
        break;
      }
      case "quote": {
        if (args.length === 5 && args[1].toLowerCase() === "sell") {
          const userId = args[2].toUpperCase();
          const outcome = parseOutcome(args[3]);
          const quantity = Number(args[4]);
          if (!outcome) {
            console.log("Outcome must be RCB or CSK.");
            break;
          }

          const quote = market.getSellQuote(userId, outcome, quantity);
          console.log(quote.message);
          break;
        }

        if (args.length === 2) {
          const quantity = Number(args[1]);
          for (const outcome of OUTCOMES) {
            const quote = market.getTradeQuote(outcome, quantity);
            console.log(quote.message);
          }
          break;
        }

        if (args.length === 3) {
          const outcome = parseOutcome(args[1]);
          const quantity = Number(args[2]);
          if (!outcome) {
            console.log("Outcome must be RCB or CSK.");
            break;
          }

          const quote = market.getTradeQuote(outcome, quantity);
          console.log(quote.message);
          break;
        }

        console.log("Usage: quote <QUANTITY> OR quote <RCB|CSK> <QUANTITY> OR quote sell <USER_ID> <RCB|CSK> <QTY>");
        break;
      }
      case "resolve": {
        if (args.length !== 2) {
          console.log("Usage: resolve <RCB|CSK>");
          break;
        }

        const winner = parseOutcome(args[1]);
        if (!winner) {
          console.log("Winner must be RCB or CSK.");
          break;
        }

        const result = market.resolve(winner);
        console.log(result.message);
        market.printScoreboard();
        break;
      }
      case "start": {
        const result = market.startGame();
        console.log(result.message);
        market.printScoreboard();
        break;
      }
      case "fee-table":
        market.printFeeTable();
        break;
      case "scoreboard":
        market.printScoreboard();
        break;
      case "reset":
        market.resetMarket();
        console.log("Market state reset. New round started.");
        market.printScoreboard();
        break;
      case "history":
        market.printTradeHistory();
        break;
      case "help":
        market.printHelp();
        break;
      case "exit":
      case "quit":
        rl.close();
        return;
      default:
        console.log("Unknown command. Type `help` for options.");
    }

    rl.prompt();
  });

  rl.on("close", () => {
    console.log("Exiting LMSR market simulator.");
    process.exit(0);
  });
}

bootstrap();
