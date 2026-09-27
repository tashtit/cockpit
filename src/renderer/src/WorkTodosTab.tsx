import type { JSX } from 'react'
import type { Provider, TodoStatus } from '../../shared/types'
import { todoSummary, type WorkModel } from '../../shared/work'
import { PROVIDER_LABEL, TodoMark } from './logos'

/** The Work panel's To-dos tab: where the agent's to-do list stands. */

const TODO_WORD: Record<TodoStatus, string> = {
  pending: 'not started',
  in_progress: 'in progress',
  completed: 'done',
  blocked: 'blocked'
}

export function WorkTodosTab({ model, provider }: { model: WorkModel; provider: Provider }): JSX.Element {
  if (model.todosKey === null) {
    return (
      <p className="work-empty">
        No to-do list yet. When {PROVIDER_LABEL[provider]} breaks its work into steps, they are kept here as it ticks
        them off.
      </p>
    )
  }
  return (
    <>
      <div className="work-meta">
        <span>{todoSummary(model.todos)}</span>
      </div>
      {model.todos.length > 0 && (
        <ol className="work-todos">
          {model.todos.map((t) => (
            <li key={t.id} className={`work-todo ${t.status}`}>
              <span className="work-todo-mark">
                <TodoMark status={t.status} />
              </span>
              <span className="sr-only">{TODO_WORD[t.status]}: </span>
              <span className="work-todo-text">{t.text}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  )
}
