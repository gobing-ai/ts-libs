export function hasRole(profile: Record<string, unknown> | null | undefined, role: string): boolean {
    if (!profile) return false;
    if (!role || typeof role !== 'string') return false;

    const zitadelRoles = profile['urn:zitadel:iam:org:project:roles'];
    if (zitadelRoles && typeof zitadelRoles === 'object') {
        try {
            if (zitadelRoles !== null && !Array.isArray(zitadelRoles) && Object.hasOwn(zitadelRoles, role)) {
                return true;
            }
        } catch {
            // Continue to other role formats when host objects reject inspection.
        }
    }

    const rolesArray = profile.roles;
    if (Array.isArray(rolesArray)) {
        return rolesArray.includes(role);
    }

    if (rolesArray && typeof rolesArray === 'object' && !Array.isArray(rolesArray)) {
        try {
            if (rolesArray !== null) {
                return Object.hasOwn(rolesArray, role);
            }
        } catch {
            // Fall through.
        }
    }

    return false;
}

export function getRoles(profile: Record<string, unknown> | null | undefined): string[] {
    if (!profile) return [];

    const roles = new Set<string>();

    const zitadelRoles = profile['urn:zitadel:iam:org:project:roles'];
    if (zitadelRoles && typeof zitadelRoles === 'object' && zitadelRoles !== null && !Array.isArray(zitadelRoles)) {
        try {
            for (const key of Object.keys(zitadelRoles)) {
                roles.add(key);
            }
        } catch {
            // Ignore host objects that reject key enumeration.
        }
    }

    const rolesArray = profile.roles;
    if (Array.isArray(rolesArray)) {
        rolesArray.forEach((role) => {
            if (typeof role === 'string') roles.add(role);
        });
    }

    if (rolesArray && typeof rolesArray === 'object' && rolesArray !== null && !Array.isArray(rolesArray)) {
        try {
            for (const key of Object.keys(rolesArray)) {
                roles.add(key);
            }
        } catch {
            // Ignore host objects that reject key enumeration.
        }
    }

    return Array.from(roles);
}
