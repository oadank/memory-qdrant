// ── Custom Error Classes ────────────────────────────────────────────────

export class MemoryError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "MemoryError";
  }
}

export class ConfigError extends MemoryError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR");
    this.name = "ConfigError";
  }
}

export class StorageError extends MemoryError {
  constructor(message: string, public readonly layer: "sqlite" | "qdrant" | "age") {
    super(message, "STORAGE_ERROR");
    this.name = "StorageError";
  }
}

export class ValidationError extends MemoryError {
  constructor(message: string, public readonly details?: unknown) {
    super(message, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

export class NotFoundError extends MemoryError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, "NOT_FOUND");
    this.name = "NotFoundError";
  }
}

export class AuthError extends MemoryError {
  constructor(message: string = "Unauthorized") {
    super(message, "AUTH_ERROR");
    this.name = "AuthError";
  }
}
