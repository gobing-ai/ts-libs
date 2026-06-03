/** Registry origin for a host capability. */
export type CapabilityOrigin = 'builtin' | 'extension';

/** Registry entry metadata. */
export interface CapabilityEntry<TCapability> {
    /** Capability implementation. */
    capability: TCapability;
    /** Registration origin. */
    origin: CapabilityOrigin;
}

/**
 * Generic, domain-agnostic capability registry shared by engine hosts.
 *
 * Stores named capabilities of an opaque type `TCapability` with replace-by-name
 * semantics and `origin` metadata. It knows nothing about what a capability *is* —
 * each engine supplies its own type and owns its own error types and override
 * semantics (the registry only reports what it stores).
 */
export class CapabilityRegistry<TCapability> {
    private readonly capabilities = new Map<string, CapabilityEntry<TCapability>>();

    constructor(private readonly kind: string) {}

    /** Register or replace a capability. */
    register(name: string, capability: TCapability, origin: CapabilityOrigin = 'extension'): void {
        this.capabilities.set(name, { capability, origin });
    }

    /** Return true when a capability exists. */
    has(name: string): boolean {
        return this.capabilities.has(name);
    }

    /** Get a registered capability or throw a clear error. */
    get(name: string): TCapability {
        const entry = this.capabilities.get(name);
        if (entry === undefined) {
            throw new Error(`Unknown ${this.kind}: ${name}`);
        }
        return entry.capability;
    }

    /** Get a registered entry (capability plus origin) without throwing. */
    getEntry(name: string): CapabilityEntry<TCapability> | undefined {
        return this.capabilities.get(name);
    }

    /** List registered capability names in insertion order. */
    list(): string[] {
        return [...this.capabilities.keys()];
    }

    /** List registered entries (name + capability + origin) in insertion order. */
    entries(): Array<readonly [string, CapabilityEntry<TCapability>]> {
        return [...this.capabilities.entries()];
    }
}
