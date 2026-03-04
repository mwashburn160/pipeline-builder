import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { HelpTopicNav } from '@/components/help/HelpTopicNav';
import { HelpContent } from '@/components/help/HelpContent';
import { HELP_TOPICS } from '@/lib/help';

export default function HelpPage() {
  const { user, isReady } = useAuthGuard();
  const router = useRouter();
  const [activeTopicId, setActiveTopicId] = useState(HELP_TOPICS[0].id);

  // Sync topic from URL query parameter
  useEffect(() => {
    const topic = router.query.topic as string;
    if (topic && HELP_TOPICS.some((t) => t.id === topic)) {
      setActiveTopicId(topic);
    }
  }, [router.query.topic]);

  const handleSelectTopic = (topicId: string) => {
    setActiveTopicId(topicId);
    router.replace({ query: { topic: topicId } }, undefined, { shallow: true });
  };

  if (!isReady || !user) return <LoadingPage />;

  const activeTopic = HELP_TOPICS.find((t) => t.id === activeTopicId) || HELP_TOPICS[0];

  return (
    <DashboardLayout title="Help">
      <div className="flex gap-6">
        {/* Sidebar topic nav — sticky on desktop */}
        <div className="hidden lg:block w-56 flex-shrink-0">
          <div className="sticky top-20">
            <HelpTopicNav
              topics={HELP_TOPICS}
              activeTopicId={activeTopicId}
              onSelectTopic={handleSelectTopic}
            />
          </div>
        </div>

        {/* Content area */}
        <div className="flex-1 min-w-0">
          {/* Mobile topic selector */}
          <HelpTopicNav
            topics={HELP_TOPICS}
            activeTopicId={activeTopicId}
            onSelectTopic={handleSelectTopic}
          />

          <HelpContent topic={activeTopic} />
        </div>
      </div>
    </DashboardLayout>
  );
}
