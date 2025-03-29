interface MemberData {
  name: string
  image: string
}

interface MessageData extends MemberData {
  updatedAt: string
  message: string
}

export const group = {
  name: 'Design Group',
  stats: {
    count: 310,
    online: 20,
  },
  members: [
    {
      name: 'Ryan Giggs',
      image:
        'https://images.unsplash.com/photo-1625504615927-c14f4f309b63?w=800&auto=format&fit=crop&q=60&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8MzZ8fGhlYWRzaG90fGVufDB8fDB8fHww',
    },
    {
      name: 'Nat Kells',
      image:
        'https://images.unsplash.com/photo-1531746020798-e6953c6e8e04?w=800&auto=format&fit=crop&q=60&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8NDZ8fGhlYWRzaG90fGVufDB8fDB8fHww',
    },
    {
      name: 'Kent Matts',
      image:
        'https://images.unsplash.com/photo-1631885628726-d60689c330db?w=800&auto=format&fit=crop&q=60&ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8OTV8fGhlYWRzaG90fGVufDB8fDB8fHww',
    },
  ],
}

export const messages: MessageData[] = [
  {
    updatedAt: '2 hrs ago',
    name: 'Segun Adebayo',
    image: '',
    message: 'What is the latest with Chakra UI and this new feature?',
  },
  {
    updatedAt: '1 hr ago',
    name: 'John Doe',
    image: '',
    message: 'How can I use the new feature in my project?',
  },
  {
    updatedAt: '30 mins ago',
    name: 'Jane Doe',
    image: '',
    message: 'Is there any documentation for this new feature?',
  },
  {
    updatedAt: '20 mins ago',
    name: 'Alice',
    image: '',
    message: 'What are the benefits of this new feature?',
  },
  {
    updatedAt: '10 mins ago',
    name: 'Bob',
    image: '',
    message: 'Can I contribute to the development of this new feature?',
  },
]
