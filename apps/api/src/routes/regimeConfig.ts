import { type FastifyInstance } from "fastify";
import { z } from "zod";
import { NotFoundError } from "@regimex/shared";
import {
  DEFAULT_REGIME_THRESHOLDS,
  RuleBasedRegimeClassifier,
  REGIME_CLASSIFIER_VERSION,
  extractFeatures,
  syntheticCandles,
  type RegimeThresholds
} from "@regimex/trading-engine";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";

const thresholdsSchema = z.object({
  adxTrendThreshold: z.number().min(10).max(50),
  adxRangeThreshold: z.number().min(5).max(40),
  emaSlopeThreshold: z.number().min(0).max(0.01),
  strongTrendScore: z.number().min(40).max(100),
  weakTrendScore: z.number().min(20).max(90),
  rangeScoreThreshold: z.number().min(30).max(100),
  breakoutScoreThreshold: z.number().min(30).max(100),
  compressionVolatilityPercentile: z.number().min(0).max(60),
  highVolatilityPercentile: z.number().min(40).max(100),
  compressionBollingerWidth: z.number().min(0.0001).max(0.1),
  minIndicatorsForConfidence: z.number().int().min(1).max(13),
  lowDataConfidenceCap: z.number().min(0).max(1)
});

export function registerRegimeConfigRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = requireAuth(ctx);

  app.get("/regime-config", { preHandler: auth }, async () => {
    const config = await ctx.prisma.regimeConfiguration.findFirst({ where: { isActive: true } });
    if (!config) {
      return {
        config: {
          name: "default",
          classifierVersion: REGIME_CLASSIFIER_VERSION,
          thresholds: DEFAULT_REGIME_THRESHOLDS
        }
      };
    }
    return { config };
  });

  app.put("/regime-config", { preHandler: auth }, async (request) => {
    const thresholds = thresholdsSchema.parse(request.body);
    const config = await ctx.prisma.regimeConfiguration.upsert({
      where: { name: "default" },
      create: {
        name: "default",
        classifierVersion: REGIME_CLASSIFIER_VERSION,
        thresholds,
        isActive: true
      },
      update: { thresholds }
    });
    return { config };
  });

  /** Dry-run the classifier over deterministic synthetic data with given thresholds. */
  app.post("/regime-config/test", { preHandler: auth }, async (request) => {
    const thresholds = thresholdsSchema.parse(request.body) as RegimeThresholds;
    const candles = syntheticCandles({ count: 400, seed: 42, drift: 0.3, volatility: 2.5 });
    const features = extractFeatures(candles);
    const classifier = new RuleBasedRegimeClassifier();

    const counts = new Map<string, number>();
    for (let i = 80; i < features.length; i++) {
      const result = classifier.classify({ features: features[i]!, thresholds });
      counts.set(result.regime, (counts.get(result.regime) ?? 0) + 1);
    }
    const sample = classifier.classify({ features: features[features.length - 1]!, thresholds });
    if (!sample) throw new NotFoundError("Sample");
    return {
      distribution: [...counts.entries()].map(([regime, count]) => ({ regime, count })),
      sample
    };
  });
}
