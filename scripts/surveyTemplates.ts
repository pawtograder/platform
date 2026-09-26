/**
 * SurveyJS templates used to seed realistic surveys, and by the survey-builder round-trip
 * tests. Kept in its own module with no imports on purpose: importing them from
 * DatabaseSeedingUtils pulls in TestingUtils, which builds a Supabase admin client at module
 * evaluation and throws when SUPABASE_URL is unset, so a pure unit test could not read them
 * without a database environment.
 */
import { TEAM_COLLABORATION_SURVEY } from "@/tests/fixtures/teamCollaborationSurvey";

export const SURVEYJS_TEMPLATES = {
  courseExperience: {
    title: "Course Experience Survey",
    description: "Help us improve the course by sharing your overall experience.",
    pages: [
      {
        name: "page1",
        elements: [
          {
            type: "rating",
            name: "overall_quality",
            title: "How would you rate the overall quality of this course?",
            rateMin: 1,
            rateMax: 5,
            minRateDescription: "Poor",
            maxRateDescription: "Excellent",
            isRequired: true
          },
          {
            type: "rating",
            name: "organization",
            title: "The course material was well-organized and easy to follow.",
            rateMin: 1,
            rateMax: 5,
            minRateDescription: "Strongly Disagree",
            maxRateDescription: "Strongly Agree",
            isRequired: true
          },
          {
            type: "comment",
            name: "most_valuable",
            title: "What did you find most valuable about this course?",
            placeholder: "Please share your thoughts...",
            rows: 4
          },
          {
            type: "comment",
            name: "suggestions",
            title: "What suggestions do you have for improving this course?",
            placeholder: "Your feedback helps us improve...",
            rows: 4
          }
        ]
      }
    ]
  },

  instructorFeedback: {
    title: "Instructor Feedback Survey",
    description: "Provide feedback on instruction and course delivery.",
    pages: [
      {
        name: "page1",
        elements: [
          {
            type: "rating",
            name: "clarity",
            title: "The instructor explained concepts clearly.",
            rateMin: 1,
            rateMax: 5,
            minRateDescription: "Strongly Disagree",
            maxRateDescription: "Strongly Agree",
            isRequired: true
          },
          {
            type: "rating",
            name: "responsiveness",
            title: "The instructor was responsive to student questions.",
            rateMin: 1,
            rateMax: 5,
            minRateDescription: "Strongly Disagree",
            maxRateDescription: "Strongly Agree",
            isRequired: true
          },
          {
            type: "radiogroup",
            name: "office_hours",
            title: "How often did you attend office hours?",
            choices: ["Never", "Rarely", "Sometimes", "Often", "Very Often"],
            isRequired: true
          },
          {
            type: "comment",
            name: "instructor_comments",
            title: "Additional comments about the instructor:",
            rows: 3
          }
        ]
      }
    ]
  },

  assignmentFeedback: {
    title: "Assignment Feedback Survey",
    description: "Share your thoughts on the course assignments and projects.",
    pages: [
      {
        name: "page1",
        elements: [
          {
            type: "rating",
            name: "difficulty",
            title: "The assignments were appropriate for the course level.",
            rateMin: 1,
            rateMax: 5,
            minRateDescription: "Too Easy",
            maxRateDescription: "Too Hard",
            isRequired: true
          },
          {
            type: "checkbox",
            name: "helpful_types",
            title: "Which types of assignments did you find most helpful? (Select all that apply)",
            choices: [
              "Programming projects",
              "Written problem sets",
              "Lab exercises",
              "Group projects",
              "Reading assignments"
            ],
            isRequired: true
          },
          {
            type: "rating",
            name: "workload",
            title: "The workload was manageable.",
            rateMin: 1,
            rateMax: 5,
            minRateDescription: "Strongly Disagree",
            maxRateDescription: "Strongly Agree"
          },
          {
            type: "comment",
            name: "assignment_suggestions",
            title: "Do you have any suggestions for future assignments?",
            placeholder: "Optional feedback...",
            rows: 3
          }
        ]
      }
    ]
  },

  midtermCheckIn: {
    title: "Midterm Check-in Survey",
    description: "Quick check-in to see how you're doing halfway through the semester.",
    pages: [
      {
        name: "page1",
        elements: [
          {
            type: "rating",
            name: "confidence",
            title: "How confident do you feel about the material covered so far?",
            rateMin: 1,
            rateMax: 5,
            minRateDescription: "Not Confident",
            maxRateDescription: "Very Confident",
            isRequired: true
          },
          {
            type: "rating",
            name: "pace",
            title: "The pace of the course is:",
            rateMin: 1,
            rateMax: 5,
            minRateDescription: "Too Slow",
            maxRateDescription: "Too Fast",
            isRequired: true
          },
          {
            type: "checkbox",
            name: "study_resources",
            title: "What resources have you been using to study? (Select all that apply)",
            choices: [
              "Lecture notes",
              "Textbook",
              "Online tutorials",
              "Study groups",
              "Office hours",
              "Discussion forums"
            ]
          },
          {
            type: "text",
            name: "review_topic",
            title: "What topic would you like more review on?",
            placeholder: "e.g., recursion, data structures..."
          },
          {
            type: "boolean",
            name: "need_help",
            title: "Do you feel you need additional support or tutoring?",
            isRequired: true
          }
        ]
      }
    ]
  },

  weeklyReflection: {
    title: "Weekly Reflection",
    description: "A quick reflection on this week's material.",
    pages: [
      {
        name: "page1",
        elements: [
          {
            type: "rating",
            name: "understanding",
            title: "How well do you understand this week's material?",
            rateMin: 1,
            rateMax: 5,
            minRateDescription: "Not at all",
            maxRateDescription: "Very well",
            isRequired: true
          },
          {
            type: "rating",
            name: "time_spent",
            title: "Approximately how many hours did you spend on coursework this week?",
            rateMin: 0,
            rateMax: 20,
            rateStep: 2,
            displayMode: "buttons"
          },
          {
            type: "text",
            name: "clearest_concept",
            title: "What concept was clearest to you this week?"
          },
          {
            type: "text",
            name: "confusing_concept",
            title: "What concept was most confusing?"
          },
          {
            type: "comment",
            name: "questions",
            title: "Any questions or concerns?",
            rows: 3
          }
        ]
      }
    ]
  },

  labFeedback: {
    title: "Lab Session Feedback",
    description: "Tell us about your experience in today's lab.",
    pages: [
      {
        name: "page1",
        elements: [
          {
            type: "rating",
            name: "lab_helpful",
            title: "How helpful was today's lab session?",
            rateMin: 1,
            rateMax: 5,
            minRateDescription: "Not helpful",
            maxRateDescription: "Very helpful",
            isRequired: true
          },
          {
            type: "radiogroup",
            name: "completion",
            title: "Did you complete the lab exercises?",
            choices: ["Yes, completed all", "Mostly completed", "About half", "Less than half", "Did not complete"],
            isRequired: true
          },
          {
            type: "rating",
            name: "ta_helpful",
            title: "The TA/lab instructor was helpful.",
            rateMin: 1,
            rateMax: 5,
            minRateDescription: "Strongly Disagree",
            maxRateDescription: "Strongly Agree"
          },
          {
            type: "comment",
            name: "lab_comments",
            title: "Additional feedback about the lab:",
            rows: 3
          }
        ]
      }
    ]
  },

  peerFeedback: {
    title: "Peer Feedback Survey",
    description: "Provide constructive feedback about your team member's contributions and collaboration.",
    pages: [
      {
        name: "page1",
        elements: [
          {
            type: "rating",
            name: "contribution",
            title: "How would you rate this team member's overall contribution to the project?",
            rateMin: 1,
            rateMax: 5,
            minRateDescription: "Minimal",
            maxRateDescription: "Exceptional",
            isRequired: true
          },
          {
            type: "rating",
            name: "communication",
            title: "This team member communicated effectively with the group.",
            rateMin: 1,
            rateMax: 5,
            minRateDescription: "Strongly Disagree",
            maxRateDescription: "Strongly Agree",
            isRequired: true
          },
          {
            type: "rating",
            name: "reliability",
            title: "This team member completed their assigned tasks on time.",
            rateMin: 1,
            rateMax: 5,
            minRateDescription: "Strongly Disagree",
            maxRateDescription: "Strongly Agree",
            isRequired: true
          },
          {
            type: "rating",
            name: "collaboration",
            title: "This team member was collaborative and supportive of others.",
            rateMin: 1,
            rateMax: 5,
            minRateDescription: "Strongly Disagree",
            maxRateDescription: "Strongly Agree",
            isRequired: true
          },
          {
            type: "rating",
            name: "quality",
            title: "The quality of work produced by this team member was:",
            rateMin: 1,
            rateMax: 5,
            minRateDescription: "Poor",
            maxRateDescription: "Excellent",
            isRequired: true
          },
          {
            type: "checkbox",
            name: "strengths",
            title: "What were this team member's strengths? (Select all that apply)",
            choices: [
              "Technical skills",
              "Problem-solving",
              "Communication",
              "Leadership",
              "Time management",
              "Creativity",
              "Attention to detail",
              "Helping others"
            ]
          },
          {
            type: "comment",
            name: "positive_feedback",
            title: "What did this team member do well?",
            placeholder: "Share specific examples of positive contributions...",
            rows: 3
          },
          {
            type: "comment",
            name: "improvement_areas",
            title: "What could this team member improve on?",
            placeholder: "Provide constructive suggestions for improvement...",
            rows: 3
          },
          {
            type: "comment",
            name: "additional_comments",
            title: "Any additional comments?",
            placeholder: "Optional...",
            rows: 3
          }
        ]
      }
    ]
  },

  teamCollaboration: TEAM_COLLABORATION_SURVEY
};
