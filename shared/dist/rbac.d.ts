import type { NextFunction, Request, Response } from 'express';
import type { Role } from './auth.js';
export declare const ALL_ROLES: readonly Role[];
/**
 * PRD §7.5 permission matrix. Single source of truth for every service.
 */
export declare const PERMISSIONS: {
    readonly 'reference:publish': readonly ["admin"];
    readonly 'sites:manage': readonly ["admin"];
    readonly 'orders:submit': readonly ["admin", "operator"];
    readonly 'dashboard:view': readonly ["admin", "operator", "auditor", "viewer"];
    readonly 'audit:view': readonly ["admin", "auditor"];
    readonly 'users:manage': readonly ["admin"];
};
export type Permission = keyof typeof PERMISSIONS;
export declare function can(role: Role | undefined, permission: Permission): boolean;
/** RBAC gate — requires req.user to be set by jwtAuth first. */
export declare function requirePermission(permission: Permission): (req: Request, res: Response, next: NextFunction) => void;
//# sourceMappingURL=rbac.d.ts.map