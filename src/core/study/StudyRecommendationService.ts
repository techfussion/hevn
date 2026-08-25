import type { StudyRecommendation } from "../../types/domain";
import type { CourseService } from "./CourseService";

export class StudyRecommendationService {
  constructor(private courseService: CourseService) {}

  /**
   * Generates actionable, explainable study recommendations based on
   * deterministic topic mastery scores and upcoming assessment deadlines.
   */
  async getStudyRecommendations(userId: string): Promise<StudyRecommendation[]> {
    const courses = await this.courseService.listCourses(userId, "active");
    if (courses.length === 0) return [];

    const recommendations: StudyRecommendation[] = [];

    for (const course of courses) {
      const topics = await this.courseService.listTopics(userId, course.id);
      const assessments = await this.courseService.listAssessments(userId, course.id);

      // Find lowest mastery topics (< 60% mastery)
      const weakTopics = topics.filter((t) => t.masteryLevel < 60);

      // Check if there is an upcoming assessment in the next 14 days
      const now = new Date();
      const upcomingExam = assessments.find((a) => {
        const due = new Date(a.dueAt);
        const diffDays = (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
        return diffDays >= 0 && diffDays <= 14;
      });

      for (const topic of weakTopics) {
        let reason = `Current mastery is ${topic.masteryLevel}%.`;
        if (upcomingExam) {
          reason += ` You have "${upcomingExam.title}" coming up on ${new Date(upcomingExam.dueAt).toLocaleDateString()}.`;
        } else {
          reason += ` Recommended review to solidify foundational understanding.`;
        }

        recommendations.push({
          topicId: topic.id,
          topicTitle: topic.title,
          courseName: course.name,
          currentMastery: topic.masteryLevel,
          reason,
          recommendedMinutes: topic.estimatedStudyMinutes || 45,
        });
      }
    }

    // Sort by lowest mastery first
    return recommendations.sort((a, b) => a.currentMastery - b.currentMastery);
  }
}
