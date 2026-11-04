// Routes. Screens live in src/screens and are the only files screen builders replace.
// The router (basename /ui) is created in main.tsx; HiveProvider picks live (default) or mock (?mock=1) data.
import { Navigate, Route, Routes } from 'react-router-dom';
import { ToastStack, ToastStackProvider } from '@/components/arc/toast-stack/toast-stack';
import { AppShell } from '@/shell/AppShell';
import { JoinRoute } from '@/shell/JoinRoute';
import { HiveProvider } from '@/shell/store';
import Activity from '@/screens/Activity';
import AgreementDetail from '@/screens/AgreementDetail';
import Agreements from '@/screens/Agreements';
import Connect from '@/screens/Connect';
import Members from '@/screens/Members';
import Overview from '@/screens/Overview';
import Pair from '@/screens/Pair';
import SignIn from '@/screens/SignIn';

export default function App() {
  return (
    <HiveProvider>
      <ToastStackProvider>
          <Routes>
            <Route path="/signin" element={<SignIn />} />
            <Route path="/join" element={<JoinRoute />} />
            {/* Hive Connect approval: standalone, so a tab the CLI opened can sign in with an invite link first. */}
            <Route path="/pair/:code" element={<Pair />} />
            <Route element={<AppShell />}>
              <Route index element={<Overview />} />
              <Route path="connect" element={<Connect />} />
              <Route path="agreements" element={<Agreements />} />
              <Route path="agreements/:id" element={<AgreementDetail />} />
              <Route path="activity" element={<Activity />} />
              <Route path="members" element={<Members />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        <ToastStack />
      </ToastStackProvider>
    </HiveProvider>
  );
}
