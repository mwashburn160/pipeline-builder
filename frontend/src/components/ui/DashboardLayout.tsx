import Link from 'next/link';
import { Sun, Moon, ArrowLeft } from 'lucide-react';
import { useDarkMode } from '@/hooks/useDarkMode';

interface DashboardLayoutProps {
  title: string;
  children: React.ReactNode;
  titleExtra?: React.ReactNode;
  actions?: React.ReactNode;
  maxWidth?: '3xl' | '4xl' | '7xl';
  mainClassName?: string;
}

const maxWidthClasses = {
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
  '7xl': 'max-w-7xl',
};

export function DashboardLayout({
  title,
  children,
  titleExtra,
  actions,
  maxWidth = '7xl',
  mainClassName = '',
}: DashboardLayoutProps) {
  const { isDark, toggle } = useDarkMode();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 transition-colors">
      <header className="bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm shadow dark:shadow-gray-900/30 border-b border-gray-200/60 dark:border-gray-700/60">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <div className="flex items-center space-x-4">
            <Link href="/dashboard" className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{title}</h1>
            {titleExtra}
          </div>
          <div className="flex items-center space-x-4">
            {actions}
            <button
              onClick={toggle}
              className="p-2 rounded-lg text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              aria-label="Toggle dark mode"
            >
              {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </header>
      <main className={`${maxWidthClasses[maxWidth]} mx-auto py-6 px-4 sm:px-6 lg:px-8 ${mainClassName}`}>
        {children}
      </main>
    </div>
  );
}
