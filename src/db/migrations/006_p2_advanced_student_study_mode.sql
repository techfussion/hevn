-- Migration 006: P2.4 Advanced Student Study Mode
-- Adds courses, course_topics, assessments, study_plans, study_sessions, and quizzes
-- Safe to execute idempotently on existing databases

-- 1. Courses Table
CREATE TABLE IF NOT EXISTS courses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  code         TEXT,
  description  TEXT,
  instructor   TEXT,
  institution  TEXT,
  semester     TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_courses_user ON courses(user_id);
CREATE INDEX IF NOT EXISTS idx_courses_user_status ON courses(user_id, status);

-- 2. Course Topics Table
CREATE TABLE IF NOT EXISTS course_topics (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id                UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                    TEXT NOT NULL,
  description              TEXT,
  ordering                 INTEGER NOT NULL DEFAULT 1,
  estimated_study_minutes  INTEGER NOT NULL DEFAULT 60,
  mastery_level            INTEGER NOT NULL DEFAULT 0 CHECK (mastery_level BETWEEN 0 AND 100),
  status                   TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'mastered')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_course_topics_course ON course_topics(course_id);
CREATE INDEX IF NOT EXISTS idx_course_topics_user ON course_topics(user_id);
CREATE INDEX IF NOT EXISTS idx_course_topics_ordering ON course_topics(course_id, ordering);

-- 3. Assessments Table
CREATE TABLE IF NOT EXISTS assessments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id          UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  assessment_type    TEXT NOT NULL DEFAULT 'exam' CHECK (assessment_type IN ('exam', 'midterm', 'final', 'quiz', 'assignment', 'project')),
  due_at             TIMESTAMPTZ NOT NULL,
  weight_percentage  NUMERIC,
  linked_task_id     UUID REFERENCES tasks(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assessments_course ON assessments(course_id);
CREATE INDEX IF NOT EXISTS idx_assessments_user_due ON assessments(user_id, due_at);

-- 4. Study Plans Table
CREATE TABLE IF NOT EXISTS study_plans (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id             UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  assessment_id         UUID REFERENCES assessments(id) ON DELETE SET NULL,
  title                 TEXT NOT NULL,
  target_date           TIMESTAMPTZ NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  total_planned_minutes INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_study_plans_user ON study_plans(user_id);
CREATE INDEX IF NOT EXISTS idx_study_plans_course ON study_plans(course_id);

-- 5. Study Sessions Table
CREATE TABLE IF NOT EXISTS study_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  study_plan_id    UUID NOT NULL REFERENCES study_plans(id) ON DELETE CASCADE,
  course_id        UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  topic_id         UUID REFERENCES course_topics(id) ON DELETE SET NULL,
  task_id          UUID REFERENCES tasks(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  scheduled_start  TIMESTAMPTZ NOT NULL,
  scheduled_end    TIMESTAMPTZ NOT NULL,
  planned_minutes  INTEGER NOT NULL DEFAULT 60,
  actual_minutes   INTEGER,
  status           TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'skipped', 'rescheduled')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_study_sessions_user_start ON study_sessions(user_id, scheduled_start);
CREATE INDEX IF NOT EXISTS idx_study_sessions_plan ON study_sessions(study_plan_id);
CREATE INDEX IF NOT EXISTS idx_study_sessions_topic ON study_sessions(topic_id);

-- 6. Quizzes Table (Interactive multi-turn quiz state machine)
CREATE TABLE IF NOT EXISTS quizzes (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id              UUID REFERENCES courses(id) ON DELETE CASCADE,
  topic_id               UUID REFERENCES course_topics(id) ON DELETE SET NULL,
  title                  TEXT NOT NULL,
  difficulty             TEXT NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
  questions              JSONB NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'ACTIVE', 'ANSWERING', 'COMPLETED', 'REVIEWED')),
  current_question_index INTEGER NOT NULL DEFAULT 0,
  score                  INTEGER NOT NULL DEFAULT 0,
  total_questions        INTEGER NOT NULL DEFAULT 0,
  answers                JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quizzes_user_status ON quizzes(user_id, status);

-- 7. Auto-update Triggers
DROP TRIGGER IF EXISTS trg_courses_updated_at ON courses;
CREATE TRIGGER trg_courses_updated_at
  BEFORE UPDATE ON courses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_course_topics_updated_at ON course_topics;
CREATE TRIGGER trg_course_topics_updated_at
  BEFORE UPDATE ON course_topics
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_assessments_updated_at ON assessments;
CREATE TRIGGER trg_assessments_updated_at
  BEFORE UPDATE ON assessments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_study_plans_updated_at ON study_plans;
CREATE TRIGGER trg_study_plans_updated_at
  BEFORE UPDATE ON study_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_study_sessions_updated_at ON study_sessions;
CREATE TRIGGER trg_study_sessions_updated_at
  BEFORE UPDATE ON study_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_quizzes_updated_at ON quizzes;
CREATE TRIGGER trg_quizzes_updated_at
  BEFORE UPDATE ON quizzes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 8. Row-Level Security
ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE quizzes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS courses_isolation ON courses;
CREATE POLICY courses_isolation ON courses
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS course_topics_isolation ON course_topics;
CREATE POLICY course_topics_isolation ON course_topics
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS assessments_isolation ON assessments;
CREATE POLICY assessments_isolation ON assessments
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS study_plans_isolation ON study_plans;
CREATE POLICY study_plans_isolation ON study_plans
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS study_sessions_isolation ON study_sessions;
CREATE POLICY study_sessions_isolation ON study_sessions
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

DROP POLICY IF EXISTS quizzes_isolation ON quizzes;
CREATE POLICY quizzes_isolation ON quizzes
  USING (user_id = current_setting('app.current_user_id', true)::uuid);
