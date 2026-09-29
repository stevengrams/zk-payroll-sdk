/**
 * Payroll domain error definitions and permission mappers.
 */
export * from "../errors/permissions";

import {
  BatchCreatorPermissionError,
  BatchCreatorPermissionErrorCode,
  type BatchCreatorRole,
} from "../errors/permissions";
import type { ErrorContext } from "../core/errors";

export interface PayrollState {
  /** Unique identifier for the payroll batch. */
  batchId: string;
  /** Current lifecycle state of the payroll batch. */
  status: "PENDING" | "EXECUTING" | "COMPLETED" | "FAILED";
  /** Optional last modified timestamp (ms). */
  updatedAt?: number;
}

export const PAYROLL_STATE_TRANSITIONS: Readonly<
  Record<PayrollState["status"], readonly PayrollState["status"][]>
> = {
  PENDING: ["EXECUTING", "FAILED"],
  EXECUTING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
};

export class PayrollStateConsistencyError extends Error {
  public readonly code = "PAYROLL_STATE_INCONSISTENT" as const;
  public readonly context: ErrorContext;
  public readonly details: {
    batchId?: string;
    currentStatus?: PayrollState["status"];
    targetStatus?: PayrollState["status"];
    allowedTransitions?: readonly PayrollState["status"][];
  };

  constructor(
    message: string,
    context: ErrorContext = {},
    details: PayrollStateConsistencyError["details"] = {}
  ) {
    super(message);
    this.name = "PayrollStateConsistencyError";
    this.context = context;
    this.details = details;
  }
}

export class PayrollAssetAvailabilityError extends Error {
  public readonly code = "PAYROLL_ASSET_UNAVAILABLE" as const;
  public readonly context: ErrorContext;
  public readonly details: {
    assetId?: string;
    requiredAmount?: bigint;
    availableAmount?: bigint;
    shortfall?: bigint;
  };

  constructor(
    message: string,
    context: ErrorContext = {},
    details: PayrollAssetAvailabilityError["details"] = {}
  ) {
    super(message);
    this.name = "PayrollAssetAvailabilityError";
    this.context = context;
    this.details = details;
  }
}

/**
 * Payroll timezone boundary error.
 * Thrown when a payroll window or schedule crosses a timezone boundary in an
 * unsupported or ambiguous way, or when timezone inputs are invalid.
 */
export class PayrollTimezoneBoundaryError extends Error {
  public readonly code = "PAYROLL_TIMEZONE_BOUNDARY" as const;
  public readonly context: ErrorContext;
  public readonly details: {
    timezone?: string;
    startTime?: number;
    endTime?: number;
    offsetMinutes?: number;
    reason?: "invalid_timezone" | "invalid_window" | "ambiguous_local_time" | "nonexistent_local_time" | "boundary_crossing";
  };

  constructor(
    message: string,
    context: ErrorContext = {},
    details: PayrollTimezoneBoundaryError["details"] = {}
  ) {
    super(message);
    this.name = "PayrollTimezoneBoundaryError";
    this.context = context;
    this.details = details;
  }
}

export interface PayrollTimezoneWindow {
  /** IANA timezone identifier, e.g. "America/New_York". */
  timezone: string;
  /** Inclusive window start in Unix milliseconds. */
  startTime: number;
  /** Exclusive window end in Unix milliseconds. */
  endTime: number;
}

export interface PayrollTimezoneValidationResult {
  /** Normalized timezone identifier. */
  timezone: string;
  /** UTC offset in minutes at the window start. */
  offsetMinutes: number;
  /** Whether the window crosses a timezone boundary (offset change). */
  crossesBoundary: boolean;
  /** Offset in minutes at the window end. */
  endOffsetMinutes: number;
}

const TIMEZONE_REGEX: RegExp = /^[A-Za-z_+-]+(?:\/[A-Za-z_.+-]+)*$/;

function normalizeTimezone(timezone: string): string {
  return timezone.trim();
}

function isValidIanaTimezone(timezone: string): boolean {
  if (!timezone || timezone.length > 255) {
    return false;
  }
  if (!TIMEZONE_REGEX.test(timezone)) {
    return false;
  }
  try {
    // Throws RangeError for invalid timezone identifiers.
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function getOffsetMinutes(timezone: string, timestamp: number): number {
  const date = new Date(timestamp);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

function isIntegerMilliseconds(value: number): boolean {
  return Number.isInteger(value) && Number.isFinite(value);
}

/**
 * Asserts that an executing caller possesses one of the required batch creator roles.
 * Throws a typed `BatchCreatorPermissionError` with actionable remediation if unauthorized.
 *
 * @param caller - Address of the caller attempting batch creation.
 * @param callerRoles - Array of roles currently held by the caller.
 * @param requiredRoles - Optional list of required roles (default: BATCH_CREATOR, PAYROLL_ADMIN, EMPLOYER).
 * @param context - Optional debugging context.
 */
export function assertBatchCreatorAuthorized(
  caller: string,
  callerRoles: string[] = [],
  requiredRoles: BatchCreatorRole[] = ["BATCH_CREATOR", "PAYROLL_ADMIN", "EMPLOYER"],
  context: ErrorContext = {}
): void {
  if (!caller || typeof caller !== "string") {
    throw new BatchCreatorPermissionError(
      "Caller address is required to verify batch creator authorization",
      BatchCreatorPermissionErrorCode.UNAUTHORIZED_CREATOR,
      { ...context, caller: caller || "[empty]" },
      {
        attemptedCaller: caller,
        requiredRoles,
      }
    );
  }

  const isAuthorized = callerRoles.some((role) =>
    requiredRoles.includes(role.toUpperCase() as BatchCreatorRole)
  );

  if (!isAuthorized) {
    throw new BatchCreatorPermissionError(
      `Caller ${caller} is not authorized to create payroll batches. Required one of: ${requiredRoles.join(", ")}`,
      BatchCreatorPermissionErrorCode.UNAUTHORIZED_CREATOR,
      { ...context, caller },
      {
        attemptedCaller: caller,
        requiredRoles,
      }
    );
  }
}

/**
 * Asserts that a payroll batch state transition is consistent and allowed.
 * Throws a typed `PayrollStateConsistencyError` with actionable remediation if invalid.
 *
 * @param current - Current payroll state snapshot.
 * @param targetStatus - Desired next status.
 * @param context - Optional debugging context.
 */
export function assertPayrollStateTransition(
  current: PayrollState,
  targetStatus: PayrollState["status"],
  context: ErrorContext = {}
): void {
  if (!current || typeof current !== "object") {
    throw new PayrollStateConsistencyError(
      "Current payroll state is required to verify state consistency",
      context,
      { targetStatus }
    );
  }

  if (!current.batchId || typeof current.batchId !== "string") {
    throw new PayrollStateConsistencyError(
      "Payroll batch ID is required to verify state consistency",
      context,
      { currentStatus: current.status, targetStatus }
    );
  }

  const allowed = PAYROLL_STATE_TRANSITIONS[current.status] ?? [];

  if (!allowed.includes(targetStatus)) {
    throw new PayrollStateConsistencyError(
      `Invalid payroll state transition for batch ${current.batchId} from ${current.status} to ${targetStatus}. Allowed: ${allowed.length > 0 ? allowed.join(", ") : "none (terminal state)"}`,
      context,
      {
        batchId: current.batchId,
        currentStatus: current.status,
        targetStatus,
        allowedTransitions: allowed,
      }
    );
  }
}

/**
 * Asserts that the required asset amount for a payroll batch is available.
 * Throws a typed `PayrollAssetAvailabilityError` with actionable remediation if insufficient.
 *
 * @param assetId - Identifier of the asset being disbursed.
 * @param requiredAmount - Amount required for the payroll batch.
 * @param availableAmount - Amount currently available in the asset pool.
 * @param context - Optional debugging context.
 */
export function assertPayrollAssetAvailability(
  assetId: string,
  requiredAmount: bigint,
  availableAmount: bigint,
  context: ErrorContext = {}
): void {
  if (!assetId || typeof assetId !== "string") {
    throw new PayrollAssetAvailabilityError(
      "Asset ID is required to verify payroll asset availability",
      { ...context, assetId: assetId || "[empty]" },
      { requiredAmount, availableAmount }
    );
  }

  if (typeof requiredAmount !== "bigint" || requiredAmount < 0n) {
    throw new PayrollAssetAvailabilityError(
      "Required amount must be a non-negative bigint",
      { ...context, assetId },
      { assetId, requiredAmount, availableAmount }
    );
  }

  if (typeof availableAmount !== "bigint" || availableAmount < 0n) {
    throw new PayrollAssetAvailabilityError(
      "Available amount must be a non-negative bigint",
      { ...context, assetId },
      { assetId, requiredAmount, availableAmount }
    );
  }

  if (availableAmount < requiredAmount) {
    const shortfall = requiredAmount - availableAmount;
    throw new PayrollAssetAvailabilityError(
      `Insufficient asset ${assetId} for payroll. Required ${requiredAmount.toString()}, available ${availableAmount.toString()}, shortfall ${shortfall.toString()}`,
      { ...context, assetId },
      { assetId, requiredAmount, availableAmount, shortfall }
    );
  }
}

/**
 * Asserts that a payroll timezone window is valid and does not cross an
 * unsupported timezone boundary. Throws a typed `PayrollTimezoneBoundaryError`.
 *
 * @param window - The payroll timezone window to validate.
 * @param context - Optional debugging context.
 * @returns Normalized timezone information including offset and boundary flag.
 */
export function assertPayrollTimezoneBoundary(
  window: PayrollTimezoneWindow,
  context: ErrorContext = {}
): PayrollTimezoneValidationResult {
  if (!window || typeof window !== "object") {
    throw new PayrollTimezoneBoundaryError(
      "Payroll timezone window is required to validate timezone boundaries",
      context,
      { reason: "invalid_window" }
    );
  }

  const timezone = typeof window.timezone === "string" ? normalizeTimezone(window.timezone) : "";

  if (!timezone || !isValidIanaTimezone(timezone)) {
    throw new PayrollTimezoneBoundaryError(
      `Invalid or unsupported timezone "${window.timezone}". Provide a valid IANA timezone identifier such as "America/New_York".`,
      { ...context, timezone: window.timezone },
      { timezone: window.timezone, reason: "invalid_timezone" }
    );
  }

  const { startTime, endTime } = window;

  if (!isIntegerMilliseconds(startTime) || !isIntegerMilliseconds(endTime)) {
    throw new PayrollTimezoneBoundaryError(
      "Payroll timezone window startTime and endTime must be integer Unix milliseconds",
      { ...context, timezone },
      { timezone, startTime, endTime, reason: "invalid_window" }
    );
  }

  if (endTime <= startTime) {
    throw new PayrollTimezoneBoundaryError(
      `Payroll timezone window endTime (${endTime}) must be greater than startTime (${startTime})`,
      { ...context, timezone },
      { timezone, startTime, endTime, reason: "invalid_window" }
    );
  }

  const offsetMinutes = getOffsetMinutes(timezone, startTime);
  const endOffsetMinutes = getOffsetMinutes(timezone, endTime - 1);
  const crossesBoundary = offsetMinutes !== endOffsetMinutes;

  if (crossesBoundary) {
    throw new PayrollTimezoneBoundaryError(
      `Payroll timezone window for ${timezone} crosses a timezone boundary (offset ${offsetMinutes} to ${endOffsetMinutes} minutes). Split the window at the transition or align it to a single offset.`,
      { ...context, timezone },
      {
        timezone,
        startTime,
        endTime,
        offsetMinutes,
        reason: "boundary_crossing",
      }
    );
  }

  return {
    timezone,
    offsetMinutes,
    crossesBoundary,
    endOffsetMinutes,
  };
}
