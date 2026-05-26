import { Link } from 'react-router-dom'

interface NavCard {
  title: string
  description: string
  href: string
  icon: string
}

const CARDS: NavCard[] = [
  {
    title: 'Create Validation Template',
    description: 'Upload a spreadsheet and define column rules, types, and allowed values.',
    href: '/parse-template',
    icon: '📋',
  },
]

export default function HomePage() {
  return (
    <div className="min-h-screen bg-background px-8 py-12">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold text-text mb-2">WIP-Val</h1>
        <p className="text-text-muted mb-10">
          Spreadsheet validation — define templates, run checks, and review results.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {CARDS.map(card => (
            <Link
              key={card.href}
              to={card.href}
              className="bg-surface rounded-xl border border-gray-200 p-6 hover:shadow-md hover:border-primary transition-all flex flex-col gap-3"
            >
              <div className="text-3xl">{card.icon}</div>
              <div>
                <p className="font-semibold text-text">{card.title}</p>
                <p className="text-sm text-text-muted mt-1">{card.description}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
