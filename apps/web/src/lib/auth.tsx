import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthResponse, AuthSuccessResponse, OrganizationDto, UserDto } from '@signage/shared';
import { api, hasToken, setToken } from './api';

const ORG_KEY = 'signage.orgId';

interface AuthContextValue {
  user: UserDto | null;
  organizations: OrganizationDto[];
  orgId: string | null;
  org: OrganizationDto | null;
  loading: boolean;
  /** True for platform superadmins (User.globalRole === 'superadmin'). */
  isSuperadmin: boolean;
  /** True when a superadmin is acting without an active organization. */
  isSystemContext: boolean;
  /**
   * Signs in. Returns `'ok'` when the session is live, or a challenge id when
   * the account has MFA on — the caller must then call `completeMfaLogin`.
   * Deliberately not a boolean: a caller that ignores the result cannot
   * accidentally treat a half-finished login as a finished one.
   */
  login: (email: string, password: string) => Promise<LoginOutcome>;
  /** Second step of login: exchanges a challenge + code for a session. */
  completeMfaLogin: (challengeId: string, code: string) => Promise<void>;
  logout: () => void;
  switchOrg: (orgId: string) => void;
  /** Clears the active organization (returns a superadmin to system context). */
  enterSystemContext: () => void;
  refreshOrgs: () => Promise<void>;
  /** Re-fetches /auth/me, e.g. after a forced password change. */
  refreshUser: () => Promise<void>;
}

export type LoginOutcome = { status: 'ok' } | { status: 'mfa_required'; challengeId: string };

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDto | null>(null);
  const [organizations, setOrganizations] = useState<OrganizationDto[]>([]);
  const [orgId, setOrgId] = useState<string | null>(localStorage.getItem(ORG_KEY));
  const [loading, setLoading] = useState(hasToken());

  const apply = useCallback((response: { user: UserDto; organizations: OrganizationDto[] }) => {
    setUser(response.user);
    setOrganizations(response.organizations);
    setOrgId((current) => {
      const valid = current != null && response.organizations.some((o) => o.id === current);
      // Superadmins default to system context; regular users auto-select their
      // (single or first) organization so they land on real data immediately.
      const next = valid
        ? current
        : response.user.globalRole === 'superadmin'
          ? null
          : (response.organizations[0]?.id ?? null);
      if (next) localStorage.setItem(ORG_KEY, next);
      else localStorage.removeItem(ORG_KEY);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!hasToken()) return;
    api
      .get<{ user: UserDto; organizations: OrganizationDto[] }>('/auth/me')
      .then(apply)
      .catch(() => {
        setToken(null);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, [apply]);

  const finish = useCallback(
    (response: AuthSuccessResponse) => {
      setToken(response.token);
      apply(response);
    },
    [apply],
  );

  const login = useCallback(
    async (email: string, password: string): Promise<LoginOutcome> => {
      const response = await api.post<AuthResponse>('/auth/login', { email, password });
      // With MFA on, this response carries no token at all — there is nothing
      // to store yet, and the challenge id is not a credential.
      if (response.status === 'mfa_required') {
        return { status: 'mfa_required', challengeId: response.challengeId };
      }
      finish(response);
      return { status: 'ok' };
    },
    [finish],
  );

  const completeMfaLogin = useCallback(
    async (challengeId: string, code: string) => {
      const response = await api.post<AuthSuccessResponse>('/auth/login/mfa', {
        challengeId,
        code,
      });
      finish(response);
    },
    [finish],
  );

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setOrganizations([]);
  }, []);

  const switchOrg = useCallback((id: string) => {
    localStorage.setItem(ORG_KEY, id);
    setOrgId(id);
  }, []);

  const enterSystemContext = useCallback(() => {
    localStorage.removeItem(ORG_KEY);
    setOrgId(null);
  }, []);

  const refreshOrgs = useCallback(async () => {
    const orgs = await api.get<OrganizationDto[]>('/orgs');
    setOrganizations(orgs);
  }, []);

  const refreshUser = useCallback(async () => {
    const response = await api.get<{ user: UserDto; organizations: OrganizationDto[] }>('/auth/me');
    apply(response);
  }, [apply]);

  const isSuperadmin = user?.globalRole === 'superadmin';
  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      organizations,
      orgId,
      org: organizations.find((o) => o.id === orgId) ?? null,
      loading,
      isSuperadmin,
      isSystemContext: isSuperadmin && !orgId,
      login,
      completeMfaLogin,
      logout,
      switchOrg,
      enterSystemContext,
      refreshOrgs,
      refreshUser,
    }),
    [
      user,
      organizations,
      orgId,
      loading,
      isSuperadmin,
      login,
      completeMfaLogin,
      logout,
      switchOrg,
      enterSystemContext,
      refreshOrgs,
      refreshUser,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** Convenience for org-scoped pages where orgId is guaranteed by the router. */
export function useOrgId(): string {
  const { orgId } = useAuth();
  if (!orgId) throw new Error('No organization selected');
  return orgId;
}
