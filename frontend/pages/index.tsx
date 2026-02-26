import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '@/hooks/useAuth';
import { LoadingPage } from '@/components/ui/Loading';

/** Landing page. Redirects authenticated users to the dashboard and guests to the login page. */
export default function Home() {
  const router = useRouter();
  const { isAuthenticated, isLoading, isInitialized } = useAuth();

  useEffect(() => {
    if (isInitialized && !isLoading) {
      if (isAuthenticated) {
        router.push('/dashboard');
      } else {
        router.push('/auth/login');
      }
    }
  }, [isAuthenticated, isLoading, isInitialized, router]);

  return <LoadingPage message="Loading..." />;
}
