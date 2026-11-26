import { Prisma } from '@prisma/client';

export const DECIMAL_ZERO = new Prisma.Decimal(0);
export const DECIMAL_EPSILON = new Prisma.Decimal('0.000001');

/**
 * Converts numeric/string input into an exact Prisma.Decimal without using
 * floating-point arithmetic. Rejects NaN and Infinity.
 */
export function toDecimal(value: unknown, fallback = '0'): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) {
    if (!value.isFinite()) {
      throw new Error('Non-finite Decimal value encountered.');
    }
    return value;
  }
  if (value === null || value === undefined || value === '') {
    return new Prisma.Decimal(fallback);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Non-finite numeric value: ${String(value)}`);
    }
    if (value === 0) return DECIMAL_ZERO;
    // Preserve exact decimal text for finite JS numbers; IEEE-754 drift is normalized explicitly in normalizeFloatArtifact().
    return new Prisma.Decimal(String(value));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return new Prisma.Decimal(fallback);
    const parsed = new Prisma.Decimal(trimmed);
    if (!parsed.isFinite()) {
      throw new Error(`Non-finite string Decimal value: ${trimmed}`);
    }
    return parsed.isZero() ? DECIMAL_ZERO : parsed;
  }
  throw new Error(`Unsupported Decimal input type: ${typeof value}`);
}

/**
 * Detects IEEE-754 floating-point drift artifacts such as 8499.999999999998
 * or 19.600000000000001 when the rounded 6-decimal representation differs by
 * less than 1e-6 while the raw value has > 6 fractional digits.
 */
export function normalizeFloatArtifact(
  value: unknown,
  scale = 6,
): { normalized: Prisma.Decimal; raw: Prisma.Decimal; hadFloatArtifact: boolean } {
  const raw = toDecimal(value, '0');
  const rounded = raw.toDecimalPlaces(scale, Prisma.Decimal.ROUND_HALF_UP);
  const diff = raw.minus(rounded).abs();
  const hadFloatArtifact =
    raw.decimalPlaces() > scale && diff.gt(DECIMAL_ZERO) && diff.lt(DECIMAL_EPSILON);
  const candidate = hadFloatArtifact ? rounded : raw;
  return {
    normalized: candidate.isZero() ? DECIMAL_ZERO : candidate,
    raw,
    hadFloatArtifact,
  };
}

export function decimalAdd(a: Prisma.Decimal, b: Prisma.Decimal): Prisma.Decimal {
  return a.plus(b);
}

export function decimalSub(a: Prisma.Decimal, b: Prisma.Decimal): Prisma.Decimal {
  return a.minus(b);
}

export function decimalAbs(a: Prisma.Decimal): Prisma.Decimal {
  return a.abs();
}

export function decimalEq(a: Prisma.Decimal, b: Prisma.Decimal): boolean {
  return a.equals(b);
}

export function decimalNearEq(
  a: Prisma.Decimal,
  b: Prisma.Decimal,
  tolerance: Prisma.Decimal = DECIMAL_EPSILON,
): boolean {
  return a.minus(b).abs().lte(tolerance);
}

export function formatDecimal(value: Prisma.Decimal, maxDecimals = 6): string {
  return value.toDecimalPlaces(maxDecimals, Prisma.Decimal.ROUND_HALF_UP).toString();
}
