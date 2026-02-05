# Frontend Updates

## Overview

These files contain updates to the frontend to align with the backend refactoring changes, including standardized error responses, improved type safety, and better error handling.

## Updated Files

### 1. `src/types/index.ts`

**Changes:**
- Added `isSystemAdmin()` and `isOrgAdmin()` helper functions
- Added `ErrorCode` constants matching backend error codes
- Added `hasErrorCode()` and `getErrorMessage()` utility functions
- Updated `ApiResponse` and `PaginatedResponse` types to match backend format
- Added `meta` field to paginated responses

### 2. `src/lib/api.ts`

**Changes:**
- Improved `ApiError` class with helper methods (`is()`, `isUnauthorized()`, `isForbidden()`, `isNotFound()`, `isRateLimited()`)
- Added `details` field to `ApiError` for additional error context
- Fixed token refresh race condition with `isRefreshing` flag
- Updated all API methods to use standardized response format (`data` wrapper)
- Removed console.log statements in production (uses `devLog` helper)
- Added missing API methods: `updateProfile()`, `changePassword()`, `deleteAccount()`
- Fixed `uploadPlugin()` endpoint path
- Organized API methods into logical sections with comments

### 3. `src/hooks/useAuth.tsx`

**Changes:**
- Added `isInitialized` state to track when auth check completes
- Used `useCallback` for stable function references
- Removed console.log statements in production (uses `devLog` helper)
- Fixed response handling for standardized format (`data.user` instead of `data || user`)
- Added `withAuth` HOC for protecting pages
- Added `organizationName` support in registration
- Better loading state management

### 4. `src/components/ErrorBoundary.tsx` (NEW)

**Features:**
- React Error Boundary component for catching render errors
- Customizable fallback UI
- Shows error details in development mode
- `withErrorBoundary` HOC for easy wrapping

### 5. `src/components/ui/Loading.tsx` (NEW)

**Components:**
- `LoadingSpinner` - Animated spinner with size variants
- `LoadingOverlay` - Full-page loading overlay
- `LoadingPage` - Loading state for pages
- `LoadingCard` - Skeleton loading for cards
- `LoadingTable` - Skeleton loading for tables
- `LoadingButton` - Button with integrated loading state

## Usage Examples

### Error Handling

```tsx
import { ApiError } from '@/lib/api';
import { ErrorCode, hasErrorCode, getErrorMessage } from '@/types';

try {
  await api.createPipeline(data);
} catch (error) {
  if (error instanceof ApiError) {
    if (error.isRateLimited()) {
      // Handle rate limiting
    } else if (error.is(ErrorCode.QUOTA_EXCEEDED)) {
      // Handle quota exceeded
    }
  }
  // Show user-friendly message
  toast.error(getErrorMessage(error));
}
```

### Protected Pages

```tsx
import { withAuth } from '@/hooks/useAuth';

function DashboardPage() {
  return <div>Dashboard content</div>;
}

export default withAuth(DashboardPage);
```

### Error Boundary

```tsx
import { ErrorBoundary } from '@/components/ErrorBoundary';

function App() {
  return (
    <ErrorBoundary>
      <MainContent />
    </ErrorBoundary>
  );
}
```

### Loading States

```tsx
import { LoadingButton, LoadingTable } from '@/components/ui/Loading';

function MyComponent() {
  const [isLoading, setIsLoading] = useState(false);

  if (isLoading) {
    return <LoadingTable rows={5} cols={4} />;
  }

  return (
    <LoadingButton isLoading={isSubmitting} className="btn-primary">
      Submit
    </LoadingButton>
  );
}
```

### Role Checks

```tsx
import { useAuth } from '@/hooks/useAuth';
import { isSystemAdmin, isOrgAdmin } from '@/types';

function AdminPanel() {
  const { user } = useAuth();

  if (!isSystemAdmin(user) && !isOrgAdmin(user)) {
    return <div>Access denied</div>;
  }

  return <div>Admin content</div>;
}
```

## Installation

Copy the updated files to your frontend project:

```
frontend/
├── src/
│   ├── components/
│   │   ├── ErrorBoundary.tsx    # NEW
│   │   └── ui/
│   │       └── Loading.tsx      # NEW
│   ├── hooks/
│   │   └── useAuth.tsx          # UPDATED
│   ├── lib/
│   │   └── api.ts               # UPDATED
│   └── types/
│       └── index.ts             # UPDATED
```

## Breaking Changes

1. **API Response Format**: All API responses now use `data` wrapper
   - Before: `response.user`
   - After: `response.data?.user`

2. **Paginated Responses**: Now include `meta` object
   - Before: `response.total`, `response.page`
   - After: `response.meta?.total`, `response.meta?.page`

3. **Auth Hook**: Added `isInitialized` - check this before redirecting
   ```tsx
   const { isAuthenticated, isInitialized } = useAuth();
   
   // Wait for auth check to complete
   if (!isInitialized) return <LoadingPage />;
   ```
