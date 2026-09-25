import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useStore } from '../store';
import {
  LayoutDashboard,
  UserPlus,
  Archive,
  FileText,
  Settings,
  Mail,
  Calendar,
  BarChart3,
  Moon,
  Sun,
  Send,
  Layers,
  GitBranch,
  Clock,
  Video,
  Target
} from 'lucide-react';

const navItems = [
  { path: '/', icon: LayoutDashboard, label: 'Today' },
  { path: '/goals', icon: Target, label: 'Goals' },
  { path: '/analytics', icon: BarChart3, label: 'Analytics' },
  { path: '/mof', icon: Layers, label: 'Middle of Funnel' },
  { path: '/new', icon: UserPlus, label: 'New Leads' },
  { path: '/old', icon: Archive, label: 'Old Leads' },
  { path: '/templates', icon: FileText, label: 'Templates' },
  { path: '/accounts', icon: Mail, label: 'Accounts' },
  { path: '/schedule', icon: Calendar, label: 'Schedule' },
  { path: '/lead-pipeline', icon: GitBranch, label: 'Lead Pipeline' },
  { path: '/stale', icon: Clock, label: 'Stale Leads' },
  { path: '/draft-scheduler', icon: Send, label: 'Draft Scheduler' },
  { path: '/data-collection', icon: Video, label: 'Data Collection' },
  { path: '/settings', icon: Settings, label: 'Settings' },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const { state, dispatch } = useStore();

  const needsSync = [...state.newLeads, ...state.oldLeads].some(l => !l.lastAnalyzed);
  const isDark = state.settings.theme === 'dark';

  function toggleTheme() {
    dispatch({
      type: 'UPDATE_SETTINGS',
      payload: { theme: isDark ? 'light' : 'dark' }
    });
  }

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      <aside style={{
        width: 220,
        borderRight: '1px solid var(--border)',
        background: 'var(--bg-sidebar)',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        height: '100vh',
      }}>
        <div style={{
          fontSize: 18,
          fontWeight: 700,
          color: 'var(--text-primary)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '20px 20px 0',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 22 }}>📧</span>
          Lead Tracker
        </div>

        {/* Scrollable nav — grows/shrinks between the fixed header above and the
            fixed theme-toggle + stats box below, so a long nav list scrolls on
            its own instead of pushing the bottom box off-screen. */}
        <nav style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '20px 20px',
        }}>
          {navItems.map(item => {
            const Icon = item.icon;
            const active = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 12px',
                  borderRadius: 8,
                  textDecoration: 'none',
                  color: active ? 'var(--accent-text)' : 'var(--text-secondary)',
                  background: active ? 'var(--accent)' : 'transparent',
                  fontSize: 14,
                  fontWeight: active ? 600 : 500,
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  if (!active) {
                    e.currentTarget.style.background = 'var(--bg-hover)';
                    e.currentTarget.style.color = 'var(--text-primary)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!active) {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = 'var(--text-secondary)';
                  }
                }}
              >
                <Icon size={18} />
                {item.label}
                {item.path === '/' && needsSync && (
                  <span style={{
                    marginLeft: 'auto',
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: 'var(--red-text)'
                  }} />
                )}
              </Link>
            );
          })}
        </nav>

        <div style={{ flexShrink: 0, padding: '0 20px 20px', borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          {/* Theme Toggle */}
          <button
            onClick={toggleTheme}
            title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              padding: '10px 12px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--bg-muted)',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 500,
              transition: 'all 0.15s ease',
              marginBottom: 12,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--bg-hover)';
              e.currentTarget.style.color = 'var(--text-primary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--bg-muted)';
              e.currentTarget.style.color = 'var(--text-secondary)';
            }}
          >
            {isDark ? <Sun size={16} /> : <Moon size={16} />}
            {isDark ? 'Light Mode' : 'Dark Mode'}
          </button>

          {/* Stats */}
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.8 }}>
            <div><strong style={{ color: 'var(--text-secondary)' }}>{state.accounts.length}</strong> accounts</div>
            <div><strong style={{ color: 'var(--text-secondary)' }}>{state.newLeads.length}</strong> new leads</div>
            <div><strong style={{ color: 'var(--text-secondary)' }}>{state.oldLeads.length}</strong> old leads</div>
            {state.staleLeads.length > 0 && (
              <div><strong style={{ color: 'var(--red-text)' }}>{state.staleLeads.length}</strong> stale leads</div>
            )}
          </div>
        </div>
      </aside>

      <main style={{
        flex: 1,
        overflow: 'auto',
        padding: 32,
        background: 'var(--bg-page)',
        color: 'var(--text-primary)',
      }}>
        {children}
      </main>
    </div>
  );
}