import Link from 'next/link';

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
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <div className="flex items-center space-x-4">
            <Link href="/dashboard" className="text-gray-500 hover:text-gray-700">
              ← Back
            </Link>
            <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
            {titleExtra}
          </div>
          {actions && (
            <div className="flex items-center space-x-4">
              {actions}
            </div>
          )}
        </div>
      </header>
      <main className={`${maxWidthClasses[maxWidth]} mx-auto py-6 px-4 sm:px-6 lg:px-8 ${mainClassName}`}>
        {children}
      </main>
    </div>
  );
}
