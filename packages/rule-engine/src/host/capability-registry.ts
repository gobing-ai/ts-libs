/** Registry origin for a host capability. */
export type CapabilityOrigin = 'builtin' | 'extension';

/** Registry entry metadata. */
export interface CapabilityEntry<TCapability> {
    /** Capability implementation. */
    capability: TCapability;
    /** Registration origin. */
    origin: CapabilityOrigin;
}

/** Typed registry used by the rule engine host. */
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

    /** List registered capability names. */
    list(): string[] {
        return [...this.capabilities.keys()];
    }
}
