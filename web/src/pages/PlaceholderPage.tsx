import type { LucideIcon } from 'lucide-react';
import { Check } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import { Badge } from '../components/ui/badge';

interface PlaceholderPageProps {
  icon: LucideIcon;
  title: string;
  description: string;
  planned: string[];
}

/**
 * Shown on routes whose content is not yet built. Sets expectations
 * rather than apologizing — the bulleted `planned` list communicates
 * what this page will answer once implemented.
 */
export function PlaceholderPage({
  icon: Icon,
  title,
  description,
  planned,
}: PlaceholderPageProps) {
  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-5">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-card">
            <Icon className="size-5 text-muted-foreground" />
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold leading-tight sm:text-2xl">
                {title}
              </h1>
              <Badge variant="muted">준비중</Badge>
            </div>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              이 페이지가 담을 것
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 sm:pt-0">
            <ul className="flex flex-col gap-2.5">
              {planned.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm">
                  <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
