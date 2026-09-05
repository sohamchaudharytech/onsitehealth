import type { NextFunction, Request, Response } from 'express';
import type { Role } from './auth.js';

export const ALL_ROLES: readonly Role[] = ['admin', 'operator', 'auditor', 'viewer', 'doctor', 'patient'];

/**
 * PRD §7.5 permission matrix. Single source of truth for every service.
 */
export const PERMISSIONS = {
  'reference:publish': ['admin', 'doctor'],
  'sites:manage': ['admin'],
  'orders:submit': ['admin', 'operator'],
  'dashboard:view': ['admin', 'operator', 'auditor', 'viewer', 'doctor', 'patient'],
  'audit:view': ['admin', 'auditor'],
  'users:manage': ['admin'],
  'hospitals:manage': ['admin'],
  'formulary:manage': ['admin', 'doctor'],
  'patients:manage': ['admin', 'doctor'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role | undefined, permission: Permission): boolean {
  if (!role) return false;
  return (PERMISSIONS[permission] as readonly string[]).includes(role);
}

/** RBAC gate — requires req.user to be set by jwtAuth first. */
export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
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
