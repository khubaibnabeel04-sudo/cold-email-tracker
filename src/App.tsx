import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { StoreProvider, useStore } from './store';
import Layout from './components/Layout';
import TodayPage from './pages/TodayPage';
import AnalyticsPage from './pages/AnalyticsPage';
import MiddleOfFunnelPage from './pages/MiddleOfFunnelPage';
import NewLeadsPage from './pages/NewLeadsPage';
import OldLeadsPage from './pages/OldLeadsPage';
import TemplatesPage from './pages/TemplatesPage';
import SettingsPage from './pages/SettingsPage';
import AccountsPage from './pages/AccountsPage';
import SchedulePage from './pages/SchedulePage';
import DraftSchedulerPage from './pages/DraftSchedulerPage';
import LeadPipelinePage from './pages/LeadPipelinePage';
import StaleLeadsPage from './pages/StaleLeadsPage';
import DataCollectionPage from './pages/DataCollectionPage';
import IdeasPage from './pages/IdeasPage';
import GoalsPage from './pages/GoalsPage';

/** Loading screen shown while app state is being fetched from the server */
function LoadingScreen() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      fontFamily: 'system-ui, sans-serif',
      background: 'var(--bg-page)',
      gap: 20
    }}>
      <div style={{
        width: 48,
        height: 48,
        borderRadius: '50%',
        border: '4px solid var(--border)',
        borderTopColor: 'var(--accent)',
        animation: 'spin 0.8s linear infinite'
      }} />
      <div style={{ textAlign: 'center' }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>
          Loading Lead Tracker
        </h2>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', margin: 0 }}>
          Syncing data from server...
        </p>
      </div>
    </div>
  );
}

/** Inner component that has access to the store context */
function AppInner() {
  const { loaded } = useStore();
  if (!loaded) return <LoadingScreen />;
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<TodayPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/mof" element={<MiddleOfFunnelPage />} />
          <Route path="/new" element={<NewLeadsPage />} />
          <Route path="/old" element={<OldLeadsPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/schedule" element={<SchedulePage />} />
          <Route path="/draft-scheduler" element={<DraftSchedulerPage />} />
          <Route path="/lead-pipeline" element={<LeadPipelinePage />} />
          <Route path="/stale" element={<StaleLeadsPage />} />
          <Route path="/data-collection" element={<DataCollectionPage />} />
          <Route path="/goals" element={<GoalsPage />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

export default function App() {
  // The Ideas page is a standalone full page (opened via window.open as its
  // own tab) and has nothing to do with the lead-tracker state, so it skips
  // StoreProvider/Layout entirely and renders on its own.
  if (window.location.pathname === '/ideas') {
    return <IdeasPage />;
  }
  return (
    <StoreProvider>
      <AppInner />
    </StoreProvider>
  );
}