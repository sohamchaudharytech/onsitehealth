export const ALL_ROLES = ['admin', 'operator', 'auditor', 'viewer'];
/**
 * PRD §7.5 permission matrix. Single source of truth for every service.
 */
export const PERMISSIONS = {
    'reference:publish': ['admin'],
    'sites:manage': ['admin'],
    'orders:submit': ['admin', 'operator'],
    'dashboard:view': ['admin', 'operator', 'auditor', 'viewer'],
    'audit:view': ['admin', 'auditor'],
    'users:manage': ['admin'],
};
export function can(role, permission) {
    if (!role)
        return false;
    return PERMISSIONS[permission].includes(role);
}
/** RBAC gate — requires req.user to be set by jwtAuth first. */
export function requirePermission(permission) {
    return (req, res, next) => {
        if (!req.user) {
            res.status(401).json({ error: 'authentication required' });
            return;
        }
        if (!can(req.user.role, permission)) {
            res.status(403).json({
                error: `forbidden: role '${req.user.role}' lacks permission '${permission}'`,
            });
            return;
        }
        next();
    };
}
//# sourceMappingURL=rbac.js.map