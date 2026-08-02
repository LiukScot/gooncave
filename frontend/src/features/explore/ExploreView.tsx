import { Search, Sparkles, TrendingUp } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const EXPLORE_SECTIONS: {
  title: string;
  description: string;
  icon: LucideIcon;
}[] = [
  {
    title: 'Search',
    description: 'Search across every synced source at once.',
    icon: Search
  },
  {
    title: 'Trending',
    description: 'See what is trending across your synced sources.',
    icon: TrendingUp
  },
  {
    title: 'New posts',
    description: 'A feed of new posts from your synced sources.',
    icon: Sparkles
  }
];

export function ExploreView() {
  return (
    <div className="row g-4">
      {EXPLORE_SECTIONS.map(({ title, description, icon: Icon }) => (
        <div key={title} className="col-12 col-md-4">
          <div className="card bg-transparent text-foreground border-0 h-full content-shell-card">
            <div className="card-body flex flex-col items-start gap-2">
              <Icon
                className="size-6 text-muted-foreground"
                aria-hidden="true"
              />
              <h2 className="h6 mb-0">{title}</h2>
              <p className="text-muted-foreground text-sm mb-0">
                {description}
              </p>
              <span className="badge bg-secondary">Coming soon</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
