-- Add peer feedback survey template as a global template
-- Uses the first class and profile found as defaults
INSERT INTO survey_templates (id, title, description, template, scope, version, created_by, class_id)
SELECT
  gen_random_uuid(),
  'Peer Feedback Survey',
  'Provide constructive feedback about your team member''s contributions and collaboration.',
  '{
    "pages": [
      {
        "name": "page1",
        "elements": [
          {
            "type": "rating",
            "name": "contribution",
            "title": "How would you rate this team member''s overall contribution to the project?",
            "rateMin": 1,
            "rateMax": 5,
            "minRateDescription": "Minimal",
            "maxRateDescription": "Exceptional",
            "isRequired": true
          },
          {
            "type": "rating",
            "name": "communication",
            "title": "This team member communicated effectively with the group.",
            "rateMin": 1,
            "rateMax": 5,
            "minRateDescription": "Strongly Disagree",
            "maxRateDescription": "Strongly Agree",
            "isRequired": true
          },
          {
            "type": "rating",
            "name": "reliability",
            "title": "This team member completed their assigned tasks on time.",
            "rateMin": 1,
            "rateMax": 5,
            "minRateDescription": "Strongly Disagree",
            "maxRateDescription": "Strongly Agree",
            "isRequired": true
          },
          {
            "type": "rating",
            "name": "collaboration",
            "title": "This team member was collaborative and supportive of others.",
            "rateMin": 1,
            "rateMax": 5,
            "minRateDescription": "Strongly Disagree",
            "maxRateDescription": "Strongly Agree",
            "isRequired": true
          },
          {
            "type": "rating",
            "name": "quality",
            "title": "The quality of work produced by this team member was:",
            "rateMin": 1,
            "rateMax": 5,
            "minRateDescription": "Poor",
            "maxRateDescription": "Excellent",
            "isRequired": true
          },
          {
            "type": "checkbox",
            "name": "strengths",
            "title": "What were this team member''s strengths? (Select all that apply)",
            "choices": [
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
            "type": "comment",
            "name": "positive_feedback",
            "title": "What did this team member do well?",
            "placeholder": "Share specific examples of positive contributions...",
            "rows": 3
          },
          {
            "type": "comment",
            "name": "improvement_areas",
            "title": "What could this team member improve on?",
            "placeholder": "Provide constructive suggestions for improvement...",
            "rows": 3
          },
          {
            "type": "comment",
            "name": "additional_comments",
            "title": "Any additional comments?",
            "placeholder": "Optional...",
            "rows": 3
          }
        ]
      }
    ]
  }'::jsonb,
  'global',
  1,
  p.id,
  c.id
FROM profiles p
CROSS JOIN classes c
LIMIT 1;
