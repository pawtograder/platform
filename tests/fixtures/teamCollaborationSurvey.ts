/**
 * Weekly team collaboration survey JSON - shared between e2e tests and DB seeding.
 * Uses survey-js format with:
 *   - Q1/Q2: checkbox (multi-select)
 *   - Q3–Q7: radiogroup (Likert-type)
 *   - Q16,Q21,Q23,Q24: radiogroup (Likert-type)
 *   - Q9: checkbox
 *   - Q15: comment (long text)
 */
export const TEAM_COLLABORATION_SURVEY = {
  title: "Weekly Team Collaboration Survey",
  description: "Please complete this weekly survey about your team collaboration experience.",
  pages: [
    {
      name: "page1",
      elements: [
        {
          type: "checkbox",
          name: "q1",
          title: "This week I have...",
          choices: [
            { value: 1, text: "Completed all my assigned tasks" },
            { value: 4, text: "Completed some of my assigned tasks" },
            { value: 2, text: "Asked a teammate for help completing my task(s)" },
            { value: 3, text: "Helped a teammate complete a portion of their task(s)" },
            { value: 5, text: "Other" }
          ],
          hasOther: true
        },
        {
          type: "checkbox",
          name: "q2",
          title: "This week I have interacted with my team by...",
          choices: [
            {
              value: 1,
              text: "Met live (including Zoom meetings, Discord voicechat, or similar) with my team"
            },
            {
              value: 2,
              text: "Participated in checkins with my team (via text, email, GroupMe, or similar)"
            },
            { value: 3, text: "Opened a Pull Request and asked my team for feedback on my code" },
            {
              value: 4,
              text: "Asked my team for feedback on my non-code work (requirements, design, test plan)"
            },
            {
              value: 5,
              text: "Reviewed technical artifacts (design, requirements, tests, or code) for my teammates"
            },
            { value: 6, text: "Other" }
          ],
          hasOther: true
        }
      ]
    },
    {
      name: "page2",
      elements: [
        {
          type: "radiogroup",
          name: "q3",
          title: "This week, I knew what I needed to get done",
          choices: [
            { value: 1, text: "Strongly disagree" },
            { value: 2, text: "Disagree" },
            { value: 3, text: "Neither agree nor disagree" },
            { value: 4, text: "Agree" },
            { value: 5, text: "Strongly agree" }
          ]
        },
        {
          type: "radiogroup",
          name: "q4",
          title: "This week, I have gotten done ___________ than I think I should have",
          choices: [
            { value: 1, text: "Much less" },
            { value: 2, text: "A bit less" },
            { value: 3, text: "About as much as" },
            { value: 4, text: "A bit more" },
            { value: 5, text: "Much more" }
          ]
        },
        {
          type: "radiogroup",
          name: "q5",
          title: "This week, my team overall has gotten done ___________ than I think we should have",
          choices: [
            { value: 1, text: "Much less" },
            { value: 2, text: "A bit less" },
            { value: 3, text: "About as much as" },
            { value: 4, text: "A bit more" },
            { value: 5, text: "Much more" }
          ]
        },
        {
          type: "radiogroup",
          name: "q6",
          title: "Overall, I think that everyone has been contributing adequately to the success of the project",
          choices: [
            { value: 1, text: "Strongly disagree" },
            { value: 2, text: "Disagree" },
            { value: 3, text: "Neither agree nor disagree" },
            { value: 4, text: "Agree" },
            { value: 5, text: "Strongly agree" }
          ]
        },
        {
          type: "radiogroup",
          name: "q7",
          title: "Next week, I intend to get done ______ than I did this week",
          choices: [
            { value: 1, text: "Much less" },
            { value: 2, text: "A bit less" },
            { value: 3, text: "About as much as" },
            { value: 4, text: "A bit more" },
            { value: 5, text: "Much more" }
          ]
        }
      ]
    },
    {
      name: "page3",
      elements: [
        {
          type: "radiogroup",
          name: "q16",
          title: "In our team we relied on each other to get the job done.",
          choices: [
            { value: 1, text: "Strongly disagree" },
            { value: 2, text: "Disagree" },
            { value: 3, text: "Neither agree nor disagree" },
            { value: 4, text: "Agree" },
            { value: 5, text: "Strongly agree" }
          ]
        },
        {
          type: "radiogroup",
          name: "q21",
          title: "Team members keep information to themselves that should be shared with others.",
          choices: [
            { value: 1, text: "Strongly disagree" },
            { value: 2, text: "Disagree" },
            { value: 3, text: "Neither agree nor disagree" },
            { value: 4, text: "Agree" },
            { value: 5, text: "Strongly agree" }
          ]
        },
        {
          type: "radiogroup",
          name: "q23",
          title: "I am satisfied with the performance of my team.",
          choices: [
            { value: 1, text: "Strongly disagree" },
            { value: 2, text: "Disagree" },
            { value: 3, text: "Neither agree nor disagree" },
            { value: 4, text: "Agree" },
            { value: 5, text: "Strongly agree" }
          ]
        },
        {
          type: "radiogroup",
          name: "q24",
          title: "We have completed the tasks this week in a way we all agreed upon.",
          choices: [
            { value: 1, text: "Strongly disagree" },
            { value: 2, text: "Disagree" },
            { value: 3, text: "Neither agree nor disagree" },
            { value: 4, text: "Agree" },
            { value: 5, text: "Strongly agree" }
          ]
        }
      ]
    },
    {
      name: "page4",
      elements: [
        {
          type: "checkbox",
          name: "q9",
          title: "My progress this week has been impeded by:",
          choices: [
            { value: 1, text: "Difficulties with technologies or course materials" },
            { value: 2, text: "Demands of other classes" },
            { value: 3, text: "Other personal responsibilities/distractions" },
            { value: 4, text: "Teammates who didn't complete their responsibilities" },
            { value: 5, text: "Communication difficulties with my teammates" },
            {
              value: 6,
              text: "Difficulties scheduling tasks so that I wasn't waiting for my team to complete their work"
            },
            { value: 7, text: "Other" },
            { value: 8, text: "None of the above: I was able to work productively" }
          ],
          hasOther: true
        },
        {
          type: "comment",
          name: "q15",
          title:
            "How do you feel about your team's collaboration process in this project? Please reflect in about two sentences."
        }
      ]
    }
  ]
};
