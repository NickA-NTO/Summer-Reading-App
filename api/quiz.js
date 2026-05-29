// AI-generated reading comprehension quiz. Generates a POOL of 12 multiple-
// choice questions per book and caches them in Redis. The client picks 5 at
// random per attempt and shuffles the answer options, so a kid retaking the
// quiz sees mostly different questions and never the same option ordering.
//
// Quality pipeline (each tier is independent and additive):
//   1. Multi-pass cross-validation (TODO 1g) — 3 independent generation
//      runs at different temperatures, cluster semantically, keep only
//      questions that appear in 2+ runs.
//   2. QC reviewer (TODO 1a) — second Opus pass scores each surviving
//      question 0-10 against the canonical summary; drops < 7.
// Can disable multi-pass via env QUIZ_MULTI_PASS=0 for cost or A/B testing.
//
// Auth: requires a valid rs_session cookie. Middleware excludes /api/* so
// each endpoint does its own check.

import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { verifySession, parseCookies, isAdmin } from "../lib/session.js";
import { moderateQuizQuestions } from "../lib/moderation.js";
import { trackError, trackEvent } from "../lib/observability.js";
import {
  getCachedQuiz,
  setCachedQuiz,
  guessGradeFromEmail,
  getCurrentlyReading,
  recordQuizOpen,
  redis,
} from "../lib/store.js";
import { normalizeGrade } from "../lib/xp.js";
import { clusterAndExtractConsensus } from "../lib/quiz-validator.js";
import {
  resolveVisibleTracks,
  trackForBook,
} from "../lib/tracks.js";

// Canonical book metadata for quiz generation. Summary is what Claude uses
// to generate the pool; it should be detailed enough that good
// comprehension questions can be drawn from concrete plot beats.
//
// quizStyle:
//   "comprehension" (default) — 12-question pool, 5/attempt, 4/5 pass.
//   "emergent" — Beginning Readers tier: 6-question pool, 3/attempt,
//                2/3 pass. Vocabulary in questions + options constrained
//                to first-100 Dolch sight words + CVC patterns.
export const QUIZ_BOOKS = {
  /* ---------- Beginning Readers (Track B emergent quiz style) ---------- */
  e01: {
    title: "We Are in a Book!",
    author: "Mo Willems",
    grade: "PK",
    quizStyle: "emergent",
    summary:
      "Gerald the gray elephant and Piggie the pink pig look at the reader. Piggie notices someone is looking at them. They realize they are in a book and the reader is reading them! They are so excited. Piggie says they should make the reader say a word out loud. Gerald asks what word. Piggie says: BANANA. They wait. Then the reader (Piggie hopes) says BANANA. Gerald and Piggie laugh and laugh. But then Gerald notices the book is ending soon. Gerald is sad and worried. Piggie has a great idea: they can ask the reader to read the book AGAIN! Gerald asks, and they wait for the reader to start over.",
  },
  e02: {
    title: "I Will Surprise My Friend!",
    author: "Mo Willems",
    grade: "PK",
    quizStyle: "emergent",
    summary:
      "Piggie tells Gerald the elephant that she wants to surprise their friend. Gerald says he wants to surprise their friend too. They both decide to hide behind the same big rock and jump out to surprise each other. Piggie hides on one side. Gerald hides on the other side. Time passes. Each one waits and waits. They both start to worry. Piggie thinks something terrible happened to Gerald. Gerald thinks something terrible happened to Piggie. They both come out from behind the rock at the same time — and finally see each other! They are so happy they hug. They forgot all about the surprise — finding each other was the best surprise.",
  },
  e03: {
    title: "Are You Ready to Play Outside?",
    author: "Mo Willems",
    grade: "PK",
    quizStyle: "emergent",
    summary:
      "Piggie is so excited to play outside with Gerald the elephant. She says it is the best day ever. Then it starts to rain. A little rain at first, then a LOT of rain. Piggie is very sad and cries that she will never play outside ever again. Gerald tries to cheer her up. Two worms appear and they are happy in the rain. Piggie sees the worms playing and decides that if worms can have fun in the rain, so can she! She and Gerald jump and splash in the puddles. Then the rain stops. Piggie is sad again — until Gerald uses his elephant trunk to spray water on her like more rain. Now they can keep playing!",
  },
  e04: {
    title: "There Is a Bird on Your Head!",
    author: "Mo Willems",
    grade: "PK",
    quizStyle: "emergent",
    summary:
      "Piggie tells Gerald the elephant that there is a bird on his head. Gerald is upset. Then there are TWO birds on his head. The two birds fall in love and build a nest on Gerald's head. The birds lay three eggs in the nest. The eggs hatch into three baby birds. Now Gerald has a whole bird family on his head! Gerald asks Piggie what to do. Piggie suggests Gerald ASK the birds to move. Gerald is surprised this might work — he politely asks the birds to move somewhere else. The birds agree and fly to land on Piggie's head instead. Now Piggie has the bird family.",
  },
  e05: {
    title: "Should I Share My Ice Cream?",
    author: "Mo Willems",
    grade: "PK",
    quizStyle: "emergent",
    summary:
      "Gerald the elephant has a yummy ice cream cone. He wonders whether to share it with his best friend Piggie. He thinks about all the reasons he should share — Piggie would be so happy, friends share, sharing is nice. Then he thinks about all the reasons not to share — what if Piggie doesn't even like this flavor? While Gerald is thinking and thinking, the ice cream melts completely. Now Gerald has no ice cream at all. Piggie arrives with her OWN ice cream cone and shares it with Gerald. Gerald learns that he should have just shared in the first place.",
  },
  e06: {
    title: "Hop on Pop",
    author: "Dr. Seuss",
    grade: "PK",
    quizStyle: "emergent",
    summary:
      "A very simple rhyming book using short words and pairs of rhyming words. Examples: 'UP PUP — Pup is up.' 'CUP PUP — Pup in cup.' Two characters who like to hop ask Pop if they can hop on him. Pop says STOP — you must not hop on Pop! Other rhymes include: 'RED NED TED and ED in BED' (all sleeping); 'HOUSE MOUSE — Mouse on house, house on mouse'; 'WALL BALL — Up on a wall'; 'NIGHT FIGHT — These fellows had a fight'. The book teaches early readers that small words can be combined to make rhyming sentences.",
  },
  e07: {
    title: "One Fish Two Fish Red Fish Blue Fish",
    author: "Dr. Seuss",
    grade: "PK",
    quizStyle: "emergent",
    summary:
      "A book of short rhymes about counting and color. The narrator describes fish: one fish, two fish, red fish, blue fish. Then they meet many silly creatures: a fish with a little car, a fish with a winking eye, a fish from far away. They have a fight with a fish called Ned. They go on a ride with Mike on his bike — Mike has ten legs and Mike pedals while they sit. They visit Mr. Gump and his seven-hump Wump. They use his humps to ride. They put their cold feet on the Zeep at night to warm them up. They look for a hop. They have a Yink that likes to wink and drink pink ink. The whole book is full of silly invented creatures with rhyming names.",
  },
  e08: {
    title: "Biscuit",
    author: "Alyssa Satin Capucilli",
    grade: "PK",
    quizStyle: "emergent",
    summary:
      "A little girl tells her small yellow puppy Biscuit that it is time for bed. But Biscuit wants one more thing first. He wants a snack. He gets a snack. Then he wants a drink. She gives him water. Then he wants to hear a story. She reads him a story. Then he wants his blanket. She gets his blanket. Then he wants his doll. She gets his doll. Then he wants a hug. She gives him a hug. Then he wants a kiss. She kisses him goodnight. Finally Biscuit is ready for bed. The little girl is tired too — she crawls into bed with Biscuit and they fall asleep together.",
  },
  e09: {
    title: "Little Bear",
    author: "Else Holmelund Minarik",
    grade: "PK",
    quizStyle: "emergent",
    summary:
      "Four short stories about Little Bear and his Mother Bear. In 'What Will Little Bear Wear?', Little Bear is cold and asks his mother for a hat, then a coat, then snow pants — but his mother says he already has a wonderful fur coat. In 'Birthday Soup', Mother Bear is missing and Little Bear thinks she forgot his birthday. He makes a Birthday Soup for his friends Hen, Duck, and Cat. Just as they sit down, Mother Bear arrives with a beautiful birthday cake. In 'Little Bear Goes to the Moon', Little Bear puts on a space helmet (a paper bag) and pretends to fly to the moon by jumping off a hill. He lands and thinks he is on the moon — but it looks just like home. In 'Little Bear's Wish', Little Bear wishes for many things — to sit on a cloud, to find a Viking boat, to meet a princess — but his mother says she will tell him a story instead, and he is happy.",
  },
  e10: {
    title: "Frog and Toad All Year",
    author: "Arnold Lobel",
    grade: "PK",
    quizStyle: "emergent",
    summary:
      "Five gentle stories about best friends Frog and Toad through the seasons. 'Down the Hill' — Frog tries to get Toad outside in winter; they go sledding and crash but Toad decides he likes winter after all. 'The Corner' — Frog tells Toad about how, as a small frog, his father told him spring is just around the corner; Toad searches around every corner until he finds spring at home. 'Ice Cream' — Toad gets two chocolate ice cream cones on a hot day and runs back to Frog, but the ice cream melts all over him on the way; Frog hardly recognizes him covered in chocolate. 'The Surprise' — Frog and Toad each secretly rake the other's yard as a kind autumn surprise; the wind blows the leaves back so neither sees the surprise, but they are happy thinking of each other. 'Christmas Eve' — Toad worries when Frog is late on Christmas Eve, imagines many terrible things happening, then Frog arrives safe and they spend Christmas together.",
  },
  e11: {
    title: "Goose on the Loose",
    author: "Phil Roxbee Cox (Usborne)",
    grade: "PK",
    quizStyle: "emergent",
    summary:
      "A short rhyming Usborne Very First Reading book. A goose escapes from its pen on a farm and runs everywhere. A boy chases the goose with a broom. The goose runs past the pig, the cow, the sheep, and the duck. The animals all watch. The goose is too fast. Finally the boy gets clever and uses some food (corn) to lead the goose calmly back to its pen. The boy is happy and the goose is happy too.",
  },
  e12: {
    title: "Pirate Pat",
    author: "Mairi Mackinnon (Usborne)",
    grade: "PK",
    quizStyle: "emergent",
    summary:
      "A short rhyming Usborne Very First Reading book. Pirate Pat is a small pirate who sails his little wooden boat across the sea. He has a green parrot that sits on his shoulder. Pat is looking for treasure. He sees fish jumping in the water. He sees a big whale spout water into the sky. He sees a giant sea monster but is not scared. Pat sails to a small island with palm trees. He digs in the sand and finds a treasure chest full of gold coins and jewels. Pat is very happy. He sails home with his treasure.",
  },

  /* ---------- Grade K ---------- */
  k01: {
    title: "The Very Hungry Caterpillar",
    author: "Eric Carle",
    grade: "K",
    summary:
      "A tiny caterpillar hatches from an egg and eats his way through one apple on Monday, two pears on Tuesday, three plums on Wednesday, four strawberries on Thursday, and five oranges on Friday. On Saturday he eats through a huge feast of junk food including chocolate cake, ice cream, a pickle, Swiss cheese, salami, a lollipop, cherry pie, sausage, a cupcake, and watermelon — and gets a stomach ache. On Sunday he eats one nice green leaf and feels better. He's no longer a tiny caterpillar but a big fat one. He builds a cocoon, stays inside for two weeks, and finally emerges as a beautiful butterfly.",
  },
  k02: {
    title: "The Cat in the Hat",
    author: "Dr. Seuss",
    grade: "K",
    summary:
      "Sally and her brother are stuck inside on a cold, wet, rainy day with nothing to do, watched only by their pet fish in a bowl. A tall Cat in a red-and-white striped hat barges in uninvited and promises fun. The Cat balances a cake, a fish in its bowl, books, milk, a fan, a toy boat, and more on his arms and head, then crashes everything down. The Cat brings out Thing One and Thing Two from inside a big red box; they fly kites through the house, knock down Mom's new pink-and-white dress, and crash things around. The fish frantically warns that Mom is on her way home. Just in time, the Cat brings out a magical pickup machine that scoops everything up and puts the house back to perfect order. The Cat leaves with a tip of his hat. When Mom asks what they did, the kids wonder if they should tell her.",
  },
  k03: {
    title: "We're Going on a Bear Hunt",
    author: "Michael Rosen",
    grade: "K",
    summary:
      "A family — a dad, four children, and a dog — sets off to find a bear, saying they're not scared. They cross long swishy-swashy grass, splash through a deep cold river, squelch through thick oozy mud, stumble through a big dark forest, swirl through a whirling snowstorm, and tiptoe into a narrow gloomy cave. Inside the cave they meet a real bear with shiny eyes. They run back the way they came — through the cave, snow, forest, mud, river, and grass — get home, slam the front door, hide under their bedroom covers, and decide they're not going on a bear hunt again. Each obstacle has a memorable sound (swishy swashy, splash splosh, squelch squerch).",
  },
  k04: {
    title: "Goldilocks and the Three Bears",
    author: "James Marshall",
    grade: "K",
    summary:
      "A little girl named Goldilocks wanders through the woods and finds the house of three bears (Papa, Mama, and Baby Bear) who are out walking while their porridge cools. She lets herself in. She tries Papa's porridge (too hot), Mama's (too cold), and Baby's (just right) — and eats it all up. She tries Papa's chair (too hard), Mama's (too soft), and Baby's (just right) — and breaks it. She tries Papa's bed (too hard), Mama's (too soft), and Baby's (just right) — and falls asleep. The three bears come home and discover the mess: 'Someone's been eating my porridge!' / 'Someone's been sitting in my chair!' / 'Someone's been sleeping in my bed!' Goldilocks wakes up to see the three bears, screams, jumps out the window, and runs away into the forest.",
  },
  k05: {
    title: "Mother Goose's Nursery Rhymes",
    author: "Iona Opie (ed.)",
    grade: "K",
    summary:
      "A classic collection of traditional English nursery rhymes and verses passed down for centuries. Includes Humpty Dumpty (who falls off a wall and can't be put back together by all the king's horses and all the king's men), Jack and Jill (who go up a hill to fetch a pail of water and tumble down), Little Miss Muffet (who sits on a tuffet eating curds and whey and is frightened away by a spider), Hey Diddle Diddle (the cat with a fiddle, the cow that jumps over the moon, the dish that runs away with the spoon), Mary Had a Little Lamb (whose fleece was white as snow and followed her to school), Twinkle Twinkle Little Star, The Itsy Bitsy Spider (who climbs up a water spout, gets washed out by rain, and climbs again when the sun dries the rain), and Hickory Dickory Dock (a mouse runs up a clock and runs down when it strikes one).",
  },
  k06: {
    title: "The Gruffalo",
    author: "Julia Donaldson",
    grade: "K",
    summary:
      "A clever little mouse walks alone through the deep dark wood. A fox sees the mouse and invites him to lunch (planning to eat him), but the mouse says he is meeting a gruffalo — a terrible creature with terrible tusks, terrible claws, and terrible teeth in his terrible jaws, with knobbly knees and turned-out toes and a poisonous wart on the end of his nose. The fox runs away scared. The mouse next meets an owl (who invites him to tea) and a snake (who invites him to a feast), and uses the same trick on both, scaring them away. But then — surprise! — a real gruffalo appears, looking exactly as the mouse described. The mouse cleverly tells the gruffalo that the mouse himself is the scariest creature in the wood and offers to prove it. They walk back through the forest where the fox, owl, and snake all flee at the sight of the mouse (actually frightened by the gruffalo behind him). The gruffalo, now convinced the mouse is terrifying, runs off too. The mouse sits down to a quiet nut feast alone.",
  },
  k07: {
    title: "If You Give a Mouse a Cookie",
    author: "Laura Numeroff",
    grade: "K",
    summary:
      "A boy gives a small mouse a chocolate-chip cookie. The mouse asks for a glass of milk to go with it. Then a straw. Drinking the milk gives him a milk mustache, so he asks for a napkin and a mirror to check it. He sees he needs a haircut and asks for nail scissors. The hair clippings need sweeping, so he asks for a broom. He sweeps the floor, mops, and is so tired he wants a nap. He needs a story to fall asleep. After his nap he wants to draw a picture. Then he wants to sign it with a pen, then hang it on the refrigerator with tape. Looking at the fridge reminds him he's thirsty — so he asks for a glass of milk. And of course, if he gets a glass of milk, he's going to want a cookie to go with it. The story loops back to where it started.",
  },
  k08: {
    title: "Green Eggs and Ham",
    author: "Dr. Seuss",
    grade: "K",
    summary:
      "A character named Sam-I-am repeatedly offers a grumpy unnamed character a plate of green eggs and ham. The grumpy character refuses again and again, saying he does not like green eggs and ham. Sam asks him to try them in many places and ways: in a house, with a mouse, in a box, with a fox, in a car, here, there, anywhere, in a tree, on a train, in the dark, in the rain, with a goat, on a boat. The grumpy character refuses every single time, growing more annoyed. The book is told in rhyme using only about 50 different words. Finally, after Sam pesters him relentlessly, the grumpy character agrees to try the green eggs and ham — and discovers he LIKES them! He thanks Sam-I-am.",
  },
  /* ---------- Grade 1 ---------- */
  a01: {
    title: "The Tale of Peter Rabbit",
    author: "Beatrix Potter",
    grade: "1",
    summary:
      "Mrs. Rabbit tells her four bunny children — Flopsy, Mopsy, Cotton-tail, and Peter — that they may play in the field but they must NOT go into Mr. McGregor's garden, because their father had been caught and put in a pie there. The three good little bunnies go to gather blackberries. Peter, who is naughty, runs straight to the garden and squeezes under the gate. He eats lettuces, French beans, and radishes, then looks for parsley to settle his stomach. Mr. McGregor spots him and chases him with a rake. Peter loses his blue jacket and his shoes escaping. He hides in a watering can, sneezes, runs again, and finally finds the gate. He gets home tired and sick. Mrs. Rabbit puts him to bed with chamomile tea while his sisters Flopsy, Mopsy, and Cotton-tail have bread and milk and blackberries for supper.",
  },
  a02: {
    title: "Owl at Home",
    author: "Arnold Lobel",
    grade: "1",
    summary:
      "Five short, gentle stories about Owl, who lives alone in a small house. In 'The Guest,' Owl invites Winter inside to warm up, but Winter blows snow and freezes the furniture. In 'Strange Bumps,' Owl sees two strange bumps under his blanket at the foot of his bed, doesn't realize they're his own feet, and gets so worried he sleeps in his armchair downstairs. In 'Tear-Water Tea,' Owl makes a special tea by thinking of sad things (chairs with broken legs, spoons that have fallen behind the stove, books that can't be read because pages are torn) to make himself cry into the kettle. In 'Upstairs and Downstairs,' Owl runs up and down his stairs trying to be in two places at once. In 'Owl and the Moon,' Owl meets the moon at the seashore, talks to it, and worries when clouds hide it, but is delighted when the moon follows him home and shines in his bedroom window.",
  },
  a03: {
    title: "Frog and Toad Are Friends",
    author: "Arnold Lobel",
    grade: "1",
    summary:
      "Five short stories about two best friends, Frog (tall and green) and Toad (short and brown). In 'Spring,' Frog wakes Toad from winter sleep by tearing pages off the calendar to trick him about the date. In 'The Story,' Toad tries to think of a story to tell Frog when Frog is sick — he stands on his head, pours water on himself, bangs his head on the wall — and can't, until Frog gets better and tells the story himself. In 'A Lost Button,' Toad loses a white four-holed button on a walk; they find many wrong buttons (black, big, two-holed, square, thin) before Toad discovers his lost button at home on the floor, and sews all the buttons onto a jacket as a gift for Frog. In 'A Swim,' Toad refuses to come out of the water in his funny swimming suit because turtles, lizards, snakes, a dragonfly, and a field mouse are all watching; when he finally does, they all laugh. In 'The Letter,' Frog writes Toad a letter because Toad has never gotten one; Frog gives it to a snail to deliver, and they wait together for four days until it arrives.",
  },
  a04: {
    title: "Nate the Great",
    author: "Marjorie Weinman Sharmat",
    grade: "1",
    summary:
      "Nate is a young boy detective who loves pancakes and works on cases in his neighborhood. His friend Annie calls him in a panic — she has lost a picture she painted of her dog Fang. Nate puts on his detective hat, eats a stack of pancakes for energy, and gets to work. He interviews Annie's brother Harry (who has been painting his own pictures of monsters and dragons), the dog Fang (who is huge and has big teeth), and Rosamond (a strange girl with four cats named Super Hex, Plain Hex, Little Hex, and Big Hex). After studying clues, Nate realizes the picture wasn't lost — Harry painted over the back of Annie's picture by mistake, hiding the real picture underneath. Nate solves the case and goes home for more pancakes.",
  },
  a05: {
    title: "Henry and Mudge: The First Book",
    author: "Cynthia Rylant",
    grade: "1",
    summary:
      "Henry is an only child with no brothers, no sisters, and no other kids on his street. He's lonely and asks his parents for a dog. They get him a tiny puppy named Mudge with soft, droopy ears. Mudge grows fast — from seven pounds to a hundred and eighty pounds, with thick neck folds and big drooping jowls. He becomes Henry's best friend. They walk to school together, and Mudge waits at the corner curb to walk Henry home. One day Henry walks home a different way without Mudge. Mudge gets lost in the woods. Both Henry and Mudge worry and search for each other through the night. They are reunited in the morning and Henry hugs Mudge for a long time. They decide they never want to be apart again, and Henry dreams of fish and Mudge dreams of dogs.",
  },
  a06: {
    title: "The Dot",
    author: "Peter H. Reynolds",
    grade: "1",
    summary:
      "Vashti is a girl who sits in art class with a blank piece of paper, convinced she can't draw. Her teacher gently tells her to just make a mark and see where it takes her. Frustrated, Vashti jabs the paper with her pen — making one small dot. Her teacher asks her to sign it. The next week, Vashti walks into art class and sees that her teacher has framed her dot in a swirly gold frame and hung it above her desk. Vashti thinks she can make a better dot than that. She starts experimenting — making big dots, bright dots, swirly dots, red dots, blue dots, yellow dots, dots made of many small dots, and even a not-a-dot dot (an empty space inside the frame). At an art show, a little boy admires her work and says he can't draw. Vashti hands him a blank paper and tells him to just make a mark and see where it takes him — passing on what her teacher taught her.",
  },
  a07: {
    title: "Where the Wild Things Are",
    author: "Maurice Sendak",
    grade: "1",
    summary:
      "Max, a boy in a wolf costume, makes mischief at home — chasing the dog with a fork, hammering nails into the wall, hanging a stuffed animal from a clothesline. His mother calls him 'WILD THING!' and sends him to bed without his supper. In his room, a forest grows up around him, the walls become the world all around, and an ocean appears with a private boat. Max sails away through night and day and in and out of weeks for almost a year to where the wild things are. The wild things are giant monsters with terrible claws, terrible roars, terrible horns, and terrible yellow eyes. They try to scare him, but Max tames them by staring without blinking. They make him king of all wild things, and they have a wild rumpus together. Max begins to feel lonely and wants to be where someone loves him best of all. He sails back home and finds his supper still hot waiting in his room.",
  },
  a08: {
    title: "The Story about Ping",
    author: "Marjorie Flack",
    grade: "1",
    summary:
      "Ping is a small yellow duck who lives on a wise-eyed boat on the Yangtze River in China with his mother, father, two sisters, three brothers, eleven aunts, seven uncles, and forty-two cousins. Every evening at sunset, the duck family climbs up a small bridge back onto the boat, and the last duck up gets a spank from the boat's master. One evening Ping is the last duck and doesn't want to be spanked, so he hides under a bush on the river bank. The boat leaves without him. Ping has adventures down the river — he sees fishermen with cormorants (birds with metal rings around their necks so they cannot swallow the fish they catch), he is captured by a boy who slips him under a basket as dinner, and the boy's family ultimately decides to let him go free. Ping finds his family's boat again the next sunset, climbs the bridge, accepts his spank from the master, and is happy to be home with his family.",
  },
  a09: {
    title: "Corduroy",
    author: "Don Freeman",
    grade: "1",
    summary:
      "Corduroy is a small teddy bear in green overalls who sits on a shelf in the toy section of a large department store, hoping someone will take him home. A little girl named Lisa wants to buy him, but her mother says no — they don't have enough money, and besides, Corduroy is missing one of the buttons on his overall straps. That night when the store is closed, Corduroy climbs off the shelf and goes searching for his lost button. He rides an escalator up (which he thinks is a mountain), wanders through the furniture department (which he thinks is a palace), and tries to pull a button off a mattress, tipping the mattress over with a loud crash. The night watchman hears the noise, finds Corduroy, and puts him back on the toy shelf. The next morning Lisa returns with money she has saved in her piggy bank, buys Corduroy, and takes him home. She sews a new button on his overall strap and tells him he is her friend.",
  },
  a10: {
    title: "Knuffle Bunny",
    author: "Mo Willems",
    grade: "1",
    summary:
      "Trixie is a little girl who can't talk in real words yet. One morning she and her daddy go on an errand to the laundromat. Trixie brings her favorite stuffed rabbit, Knuffle Bunny. Daddy puts the laundry in the washing machine (along with Knuffle Bunny by accident, without realizing). They leave the laundromat. On the way home, Trixie realizes Knuffle Bunny is missing. She tries to tell Daddy with babbling and grunts ('Aggle flaggle klabble!'), but he doesn't understand and thinks she's just being fussy. She gets more and more upset, finally going boneless and crying. When they get home, Mommy immediately notices Knuffle Bunny is missing. The whole family rushes back to the laundromat. Daddy frantically searches through the washing machines, finally finding the soggy bunny inside one of them. Trixie speaks her first real words: 'Knuffle Bunny!!!'",
  },
  a11: {
    title: "The Ugly Duckling",
    author: "Hans Christian Andersen",
    grade: "1",
    summary:
      "A mother duck sits on her eggs. Most hatch into normal little yellow ducklings, but one egg is bigger and takes longer to hatch — out comes a large, gray, awkward duckling. The other animals on the farm — ducks, chickens, the turkey — laugh at him, peck him, and chase him away. Even his own siblings reject him. Heartbroken, the ugly duckling runs away. He spends a long, hard winter alone — nearly freezing in an icy pond, hiding from hunters and their dogs, and surviving briefly with the help of a peasant farmer who takes him in. When spring finally comes, the ugly duckling sees a flock of beautiful white swans gliding across a pond. He swims toward them, expecting them to attack him — but instead they greet him as one of their own. When he looks down at his reflection in the water, he sees that he has grown into a beautiful white swan. He realizes he was never an ugly duckling at all — he was always meant to be a swan.",
  },
  /* ---------- Grade 2 ---------- */
  b01: {
    title: "The True Story of the Three Little Pigs",
    author: "Jon Scieszka",
    grade: "2",
    summary:
      "Alexander T. Wolf tells his own version of the famous fairy tale from prison, where he is locked up. He claims the whole story has been misunderstood. He says he just had a terrible cold (with huge sneezes) and went to borrow a cup of sugar from his neighbor, the first little pig, to bake a birthday cake for his dear old granny. When the first pig didn't answer the door, the wolf says he sneezed so hard it accidentally blew down the pig's straw house — and the pig was dead inside. The wolf says it would have been a shame to waste a perfectly good ham dinner, so he ate the pig. The same thing happens at the second pig's stick house. At the third pig's brick house, the wolf is still sneezing and asking for sugar — but the third pig insults his granny, the wolf loses his temper and tries to break in, the police arrive, and the news media exaggerates the whole thing into the famous story. The wolf insists he was framed.",
  },
  b02: {
    title: "Owl Moon",
    author: "Jane Yolen",
    grade: "2",
    summary:
      "A young girl goes 'owling' for the first time, late at night in winter, with her father. The snow is bright white and the moon is full. They walk through the dark pine trees, past their farm, and into the woods. They have to be silent — owling requires no talking and no questions, the girl reminds herself. Pa makes a call by cupping his hands around his mouth and hooting ('Whoo-whoo-whoo-whoo-whoooooo'). At first no owl answers, and they walk deeper into the forest. Pa calls again. This time a great horned owl answers, then flies down silently on huge wings and lands on a branch right in front of them. Pa shines his flashlight on it. The girl and the owl look at each other for a long quiet moment in the snowy moonlight. Then the owl flies away. They walk home together, and the girl reflects that going owling needs hope and the patience to be quiet — that you don't need words or warm hands, just hope.",
  },
  b03: {
    title: "The Velveteen Rabbit",
    author: "Margery Williams",
    grade: "2",
    summary:
      "On Christmas morning, a boy receives a stuffed velveteen rabbit as a gift. At first the Rabbit is loved, but soon the boy plays with newer, fancier mechanical toys and the Rabbit sits forgotten on the nursery shelf. The wise old Skin Horse, who has lived in the nursery longest, tells the Rabbit about being 'Real' — that toys become Real when a child loves them for a very long time, until their fur is rubbed off, their joints loosen, and they get shabby. One night the boy's nanny grabs the Rabbit for him at bedtime because his favorite china dog has been lost, and from then on they become inseparable. The Rabbit is loved threadbare. The boy says 'You aren't a toy. You're REAL.' Then the boy gets very sick with scarlet fever. After he recovers, the doctor orders all his old playthings burned to prevent infection — including the Velveteen Rabbit. The Rabbit, alone in the garbage pile at the bottom of the garden, cries a real tear. From his tear grows the nursery magic Fairy, who tells him he was Real to the boy and now she will make him Real to everyone. The Rabbit transforms into a real, living rabbit and hops away to join the wild rabbits in the woods.",
  },
  b04: {
    title: "The Lighthouse Family: The Storm",
    author: "Cynthia Rylant",
    grade: "2",
    summary:
      "A lonely white cat named Pandora lives in a lighthouse on a small island and faithfully keeps the light burning each night for ships at sea. A small brown dog named Seabold is sailing alone in a small boat when a terrible storm wrecks him on the rocks below the lighthouse. Pandora rescues him, nurses him back to health with broth and warm blankets, and they slowly become friends as Seabold recovers from his broken leg. One night during another storm, they hear a tiny knock at the lighthouse door — three orphaned mice (the brother Whistler, and his two sisters Lila and the very small Tiny) have washed up on the rocks. Pandora and Seabold welcome the mice in and feed them. Together — a cat, a dog, and three little mice — they discover that they have become a family. This is the first book in the Lighthouse Family series.",
  },
  b05: {
    title: "Flat Stanley: His Original Adventure",
    author: "Jeff Brown",
    grade: "2",
    summary:
      "Stanley Lambchop is an ordinary boy until one night his giant bulletin board falls on him in his sleep. He wakes up perfectly flat — only half an inch thick, but otherwise the same. At first being flat is fun: he can slide under doors, fit into envelopes, and his mother folds him up and carries him in her purse. His parents save money on a trip by mailing Stanley in an envelope to visit a friend in California. When his mother loses her diamond ring down a sidewalk grate, Stanley is lowered down on a string to retrieve it. He helps the police catch art thieves at a museum by pretending to be a painting on the wall — when the thieves arrive at night, he jumps out and scares them, and they're arrested. But Stanley starts feeling sad and self-conscious; kids start calling him names. His younger brother Arthur has an idea: he gets a bicycle pump, pokes the pump nozzle into Stanley's mouth, and pumps him back up to a normal three-dimensional shape. The two brothers high-five and go to bed happy.",
  },
  b06: {
    title: "Mercy Watson to the Rescue",
    author: "Kate DiCamillo",
    grade: "2",
    summary:
      "Mercy Watson is a pig who lives with Mr. and Mrs. Watson, who treat her like a daughter. Mercy LOVES buttered toast — it's her favorite food in the world. One night Mercy can't sleep, so she sneaks into the Watsons' bed in the middle of the night for comfort. The bed is too small and Mercy is too big — it slowly cracks and begins to fall through the floor. Mr. and Mrs. Watson wake up in a panic and shout for help. Mercy, sensing an emergency, climbs off the bed and leaves the room — but instead of getting help, she goes to the kitchen because she suddenly smells buttered toast in the neighbor's house. She runs through the neighborhood searching for the toast smell, terrifying the elderly Lincoln sisters next door (Eugenia and Baby), who think she's a burglar. Eugenia calls the fire department, who come and rescue the Watsons from the collapsing bed (and Mercy from the Lincolns' kitchen). Everyone ends up eating buttered toast together at the Watsons' kitchen table — including the firefighters and the Lincoln sisters. The book ends with a recipe for buttered toast.",
  },
  b07: {
    title: "Fantastic Mr. Fox",
    author: "Roald Dahl",
    grade: "2",
    summary:
      "Mr. Fox lives with his wife and four small fox children in a cozy hole under a tree on a hill. Every night he sneaks down to one of three farms — owned by three nasty farmers named Boggis (fat, eats three boiled chickens with dumplings every day), Bunce (short, eats doughnuts with goose-liver paste), and Bean (skinny, drinks gallons of cider) — and steals food. The farmers get fed up and decide to stake out his hole with shotguns. They shoot off the end of his tail, but he escapes underground. The farmers try to dig him out with shovels, then with bulldozers and excavators, destroying the entire hill. The Fox family starves underground for days. Then Mr. Fox has a brilliant plan: instead of digging up, dig sideways. He and his children tunnel into Boggis's chicken house, Bunce's storehouse of geese and ducks, and Bean's secret cider cellar. They steal a feast. Mr. Fox invites the other underground animals (Badger, Mole, Rabbit, and Weasel) and their families to a grand banquet underground. The three farmers are left waiting outside the hole in the rain forever, never realizing the foxes are now living comfortably below them.",
  },
  b08: {
    title: "Stellaluna",
    author: "Janell Cannon",
    grade: "2",
    summary:
      "Stellaluna is a baby fruit bat. One night as her mother Mother Bat flies through the forest carrying her, a great owl swoops out of the darkness and attacks them. Stellaluna falls from her mother's grasp and tumbles down through the leaves into a bird's nest. The mother bird who lives in the nest already has three baby birds named Pip, Flitter, and Flap. She raises Stellaluna alongside them, but on bird rules: Stellaluna must sleep at night and stay awake in the day, eat bugs instead of fruit, and stop hanging upside down. Stellaluna tries to be a good bird but it feels wrong — she misses her mother and wants to hang by her feet. One day Stellaluna and her bird siblings get separated. Stellaluna meets other bats hanging from a tree branch. They recognize that she's a bat too. Stellaluna is reunited with her real mother Mother Bat and learns she's been raised by birds. She brings her bird friends to meet the bats. The birds and bats discover they see the world very differently — but they remain friends, learning to appreciate their differences and the strangeness of being so different yet so alike.",
  },
  b09: {
    title: "The Magic Faraway Tree",
    author: "Enid Blyton",
    grade: "2",
    summary:
      "Three siblings — Joe, Beth, and Frannie — move to the countryside next to a magical enchanted forest. At the top of a giant Faraway Tree that grows in the forest, a different magical land arrives every few days through a hole in the clouds — but the land moves on after a while, so visitors have to climb back down before it leaves or they'll be stuck forever. The children meet the tree's strange residents: Moon-Face (a round-faced creature who lives at the top with a slippery-slip slide that goes all the way down inside the trunk), Silky the Fairy (who has long golden hair), the Saucepan Man (deaf, covered in pots and pans that clang as he walks), and Mr. Watzisname (who is always asleep). They climb up to visit lands like the Land of Take-What-You-Want, the Land of Birthdays, the Rocking Land (where everything rocks back and forth), the Land of Topsy-Turvy, and the Land of Goodies. Each visit is a separate adventure where they sometimes barely escape back down the tree in time before the land moves on with them inside.",
  },

  /* ---------- Usborne First Reading — Grade K ---------- */
  u01: {
    title: "The Enormous Turnip",
    author: "Traditional (Usborne)",
    grade: "K",
    summary:
      "An old man plants a tiny turnip seed and waters it every day. It grows into a huge, enormous turnip — far too big to pull out by himself. He calls his wife to help, but together they still cannot pull it out. The wife calls the little girl, the little girl calls the little boy, the little boy calls the dog, the dog calls the cat, and the cat calls the mouse. All of them pull together in a long chain, pulling as hard as they possibly can. Finally, with an enormous HEAVE, the turnip comes flying out of the ground and they all fall down in a heap. That evening they all share delicious turnip soup together. The story repeats the growing chain of helpers each time, showing that working together is how they succeed.",
  },
  u02: {
    title: "The Gingerbread Man",
    author: "Traditional (Usborne)",
    grade: "K",
    summary:
      "A little old woman bakes a gingerbread man in her oven. As soon as the oven door opens, the gingerbread man jumps out and runs away, shouting 'Run, run, as fast as you can! You can't catch me, I'm the gingerbread man!' He runs away from the little old woman, the little old man, a cow, a horse, a group of farmers in a field, and a school full of children — all chasing him and all failing to catch him. Each time he escapes he repeats his rhyme. At last he comes to a river he cannot cross. A sly fox offers to carry him across on his tail. The gingerbread man climbs on. The fox flips him into the air and snaps him up, and that is the end of the gingerbread man.",
  },
  u03: {
    title: "Chicken Licken",
    author: "Traditional (Usborne)",
    grade: "K",
    summary:
      "Chicken Licken is walking under an oak tree when an acorn falls and hits her on the head. She is convinced the sky is falling down and decides she must go and tell the king. On her way she meets Henny Penny, Cocky Locky, Ducky Lucky, Drakey Lakey, Goosey Loosey, and Turkey Lurkey one by one, and each time she says 'The sky is falling! I'm going to tell the king!' and each new animal joins her. Eventually they meet Foxy Loxy, who says he knows a short cut to the king's palace. He leads them all into his dark den underground. They are never seen again and Chicken Licken never does get to tell the king. The story's lesson is about not panicking and not following strangers.",
  },

  /* ---------- Usborne First Reading — Grade 1 ---------- */
  u04: {
    title: "Jack and the Beanstalk",
    author: "Traditional (Usborne)",
    grade: "1",
    summary:
      "Jack and his mother are very poor and their only cow has stopped giving milk. Jack's mother sends him to market to sell the cow. On the way he meets a strange man who offers magic beans in exchange for the cow. Jack trades the cow for the beans and brings them home. His mother is furious and throws the beans out the window. Overnight, a giant beanstalk grows all the way up into the clouds. Jack climbs it and discovers a huge castle. A kind giantess hides Jack from her husband, a terrifying giant who bellows 'Fee-fi-fo-fum! I smell the blood of an Englishman!' On his first visit Jack steals a bag of gold coins. On his second visit he steals a magic hen that lays golden eggs. On his third visit he steals a golden harp that plays beautiful music by itself. The harp cries out, waking the giant. Jack races down the beanstalk with the giant chasing him. Jack reaches the bottom and chops the beanstalk down with an axe. The giant falls and is never seen again. Jack and his mother live happily ever after with the golden hen providing for them.",
  },
  u05: {
    title: "The Princess and the Pea",
    author: "H.C. Andersen (Usborne)",
    grade: "1",
    summary:
      "A prince travels the world looking for a real princess to marry, but he can never be certain any princess he meets is a genuine real one. He returns home sad and unmarried. One stormy night, a young woman arrives at the castle gate, soaking wet from the rain, claiming to be a real princess. The old queen decides to test her. She secretly places one single dried pea at the very bottom of the bed, then piles twenty mattresses on top, and twenty feather quilts on top of those. The young woman sleeps on this enormous stack. In the morning the prince asks how she slept. She says she had a terrible night — she tossed and turned and felt something terribly hard pressing up through all the mattresses, and she is black and blue with bruises. Only a real princess could be so delicate as to feel one pea through twenty mattresses and twenty quilts. The prince knows she must be a real princess and asks her to marry him. The pea is put on display in a museum where it can still be seen today.",
  },
  u06: {
    title: "The Elves and the Shoemaker",
    author: "Brothers Grimm (Usborne)",
    grade: "1",
    summary:
      "A kind shoemaker and his wife have fallen on hard times. One evening he cuts out the last piece of leather he can afford to make one pair of shoes, but he is too tired to sew them and goes to bed. In the morning he finds a perfect pair of shoes already made on his workbench — the finest stitching he has ever seen. He sells the shoes for a high price and buys more leather. The same thing happens every night — he cuts the leather out, and every morning the shoes are finished without explanation. He becomes prosperous and famous. On Christmas Eve, he and his wife hide behind a curtain to watch. They see two tiny elves with bare feet and ragged clothes dancing and sewing the shoes with incredible skill. The shoemaker and his wife are so grateful they decide to make the elves a gift: warm little coats, trousers, and tiny shoes. They leave the gifts out. The elves discover them, put on the clothes with great joy, and dance out the door. The elves never return, but the shoemaker and his wife are never poor again.",
  },

  /* ---------- Usborne Young Reading Series 1 — Grade 2 ---------- */
  u07: {
    title: "The Wizard of Oz",
    author: "L. Frank Baum (Usborne)",
    grade: "2",
    summary:
      "Dorothy lives on a farm in Kansas with her Auntie Em, Uncle Henry, and her little dog Toto. A great tornado picks up their farmhouse and drops it in the magical land of Oz, crushing and killing the Wicked Witch of the East and freeing the Munchkins who lived under her power. The Good Witch of the North gives Dorothy the dead witch's silver slippers and tells her to follow the Yellow Brick Road to the Emerald City, where the great Wizard might help her get home. Along the Yellow Brick Road Dorothy meets a Scarecrow who wants a brain, a Tin Woodman who wants a heart, and a Cowardly Lion who wants courage. They travel together through dangers: a field of enchanted poppies that put Dorothy and the Lion to sleep, flying monkeys controlled by the Wicked Witch of the West, and a terrifying dark castle. The Wicked Witch of the West, who wants the silver slippers, captures Dorothy. Dorothy throws a bucket of water on her to put out the fire and accidentally melts the witch. When they reach the Wizard they discover he is an ordinary man hiding behind a curtain who can do no real magic. He sends them away with words: he gives the Scarecrow a diploma, the Tin Man a heart-shaped clock, the Lion a medal for courage. Dorothy learns she can use the silver slippers to go home by clicking her heels three times and saying 'There's no place like home.' She wakes up in Kansas, safe with her family.",
  },
  u08: {
    title: "Rapunzel",
    author: "Susanna Davidson (Usborne)",
    grade: "2",
    summary:
      "A poor husband and wife long for a child of their own. Behind their cottage they can see a beautiful walled garden full of vegetables and herbs — but it belongs to a wicked witch. The wife sees rampion (rapunzel) lettuce growing there and craves it so much she will die without it. Her husband sneaks over the wall to steal some, but the witch catches him. She agrees to let him live only if they promise her their baby when it is born. The baby girl is born with golden hair, and the witch takes her away and names her Rapunzel. The witch locks Rapunzel in a tall stone tower deep in the forest. The tower has no door and only one window high at the top. Rapunzel's hair grows very long. When the witch wants to enter she calls 'Rapunzel, Rapunzel, let down your hair' and climbs up using Rapunzel's golden hair as a ladder. One day a young prince riding through the forest hears Rapunzel singing. He hides and watches the witch call up and climb. After the witch leaves the prince calls the same words. Rapunzel lets down her hair and the prince climbs up. They fall in love and plan to escape together. But the witch discovers them. She angrily cuts off Rapunzel's golden hair and banishes her to a desert. She tricks the prince: when he climbs the cut-off hair, the witch is at the top instead. The prince falls from the tower into thorn bushes that scratch out his eyes, blinding him. He wanders blind through the forest for years. Eventually he reaches the desert and hears Rapunzel singing. When they reunite, her tears of joy fall on his eyes and restore his sight. They return to his kingdom and live happily ever after.",
  },
  u09: {
    title: "Pinocchio",
    author: "Carlo Collodi (Usborne)",
    grade: "2",
    summary:
      "A kind old woodcarver named Geppetto carves a puppet from an enchanted piece of wood that can move and talk on its own even before it is finished. He names the puppet Pinocchio. The very first day Pinocchio runs away and gets Geppetto arrested. A wise Talking Cricket warns Pinocchio to be good and go to school, but Pinocchio ignores him. Pinocchio burns his own feet off and has many adventures: he is cheated by a Fox and Cat who promise to plant his gold coins in a magic 'Field of Miracles' where they will multiply, but they steal the coins. A blue-haired fairy named the Blue Fairy finds Pinocchio and nurses him back to health. When Pinocchio tells lies his nose grows longer. He is tricked into going to Pleasure Island — a place where naughty boys who never study are turned into donkeys. Pinocchio starts to turn into a donkey but escapes into the sea. He is swallowed by a great dogfish (a whale-like creature). Inside the fish Pinocchio finds old Geppetto who was also swallowed while searching for him. Pinocchio carries Geppetto on his back and swims to shore. Pinocchio finally learns to be hardworking, kind, and unselfish. The Blue Fairy rewards him by turning him from a wooden puppet into a real live boy.",
  },

  /* ---------- Grade 3 ---------- */
  c01: {
    title: "Magic Tree House #1: Dinosaurs Before Dark",
    author: "Mary Pope Osborne",
    grade: "3",
    summary:
      "Eight-year-old Jack and his seven-year-old sister Annie live in the town of Frog Creek, Pennsylvania. While walking in the woods near their home, Annie spots a tree house high in an oak tree, full of books. They climb up using a rope ladder. Jack picks up a book about dinosaurs and wishes he could see one. The tree house starts to spin and they're suddenly in a prehistoric world. They meet a friendly herbivore called a Pteranodon, a peaceful Triceratops, and a duck-billed Anatosaurus. They also encounter a fearsome T-Rex who chases Jack. The Pteranodon helps Jack escape by carrying him through the air back to the tree house. Jack and Annie also find a gold medallion with the letter M engraved on it, hinting at a mysterious owner of the tree house. They wish to go home, and the tree house spins again, returning them to Frog Creek. Hardly any time has passed at home. Jack keeps the medallion as proof of their adventure. The book ends with hints that they'll return to the tree house for more time-traveling adventures.",
  },
  c02: {
    title: "A to Z Mysteries: The Absent Author",
    author: "Ron Roy",
    grade: "3",
    summary:
      "Three friends — Dink (Donald David Duncan), Josh, and Ruth Rose — live in Green Lawn, Connecticut. Dink's favorite author, the mystery writer Wallis Wallace, is scheduled to come to the Green Lawn Book Nook to sign copies of his new book. Dink writes him a fan letter and Wallis writes back. On the day of the signing, Wallis never arrives. The bookstore owner Mr. Paskey is worried. Dink, Josh, and Ruth Rose decide to investigate. They find clues at the train station: torn pages from Wallis's book, a single shoe, and a strange phone call. They visit the local hotel, the Shangri-La Hotel, where they believe Wallis was staying. They search his hotel room and find more clues. Eventually they realize Wallis Wallace faked his own kidnapping as a publicity stunt for his new book — but he didn't intend for kids to genuinely worry. He shows up unharmed, apologizes, and signs Dink's book personally. The mystery is solved, and the kids have a great story to tell.",
  },
  c03: {
    title: "Junie B. Jones and the Stupid Smelly Bus",
    author: "Barbara Park",
    grade: "3",
    summary:
      "Junie B. Jones (the B stands for Beatrice but she doesn't like Beatrice) is starting her first day of kindergarten. Her mother takes her to school. She meets her teacher, who she calls Mrs. (she can't remember the teacher's full name). She rides the school bus there with kids of all ages, and a mean kid named Jim sticks gum in her hair and another boy yells in her ear. Junie B. decides the bus is the stupidest, smelliest thing ever and refuses to ride it home. At the end of the school day, she hides in a supply closet in her classroom so she won't have to get on the bus. She entertains herself by exploring the empty school — eating lunch leftovers, drawing on the chalkboard, sneaking into the principal's office and playing with his stamps. Eventually the school staff notice she's missing. Her mother, the principal, and the police are called. Junie B. is found, lectured, but ultimately her parents come pick her up in the car instead of putting her back on the bus. The story is told in Junie B.'s funny, ungrammatical first-person voice.",
  },
  c04: {
    title: "The Boxcar Children",
    author: "Gertrude Chandler Warner",
    grade: "3",
    summary:
      "Four orphaned siblings — Henry (the oldest, around 14), Jessie (12), Violet (10), and Benny (5) — have just lost their parents and run away rather than live with their unknown grandfather, whom they've heard is mean. They wander the countryside looking for food and shelter. During a thunderstorm they discover an abandoned red boxcar in the woods near a town and decide to make it their home. They fix it up with found objects — Henry finds a dump where they get cracked dishes, a teakettle, and a wheel for Benny's toy cart. Jessie finds a stream where they get water. Henry gets odd jobs in town (mowing lawns, picking cherries for Dr. Moore) to earn money. They adopt a stray dog named Watch. Violet gets sick, and Henry takes her to kind Dr. Moore. Dr. Moore figures out the children's identity and realizes he is friends with their grandfather, James Alden, who has been searching for them. Mr. Alden turns out to be loving and rich. He takes them home to live with him, and even has the boxcar moved into his backyard so they can play in it.",
  },
  c05: {
    title: "Charlotte's Web",
    author: "E.B. White",
    grade: "3",
    summary:
      "On the Arable family farm, an eight-year-old girl named Fern saves a runty piglet from being killed by her father. She names him Wilbur and raises him on a bottle. When Wilbur outgrows her care, he is sold to her uncle Homer Zuckerman, who keeps him in a barn. Wilbur is lonely until he meets the other barn animals: the rat Templeton (selfish but useful), a goose, a sheep, and a wise gray spider named Charlotte A. Cavatica who lives in the doorway above his pen. Charlotte and Wilbur become best friends. When Wilbur learns Mr. Zuckerman plans to kill him for Christmas ham, he is terrified. Charlotte promises to save him. She weaves words into her web — 'SOME PIG,' then 'TERRIFIC,' then 'RADIANT,' and finally 'HUMBLE' — making Wilbur famous. The Zuckermans take Wilbur to the county fair, where Charlotte writes 'HUMBLE' in her last web. Wilbur wins a special prize, guaranteeing he'll never be killed. But Charlotte is dying — she has just laid 514 eggs in an egg sac, which Wilbur carries back to the barn. Charlotte dies alone at the fair. The next spring, hundreds of baby spiders hatch from Charlotte's sac. Most fly away on the wind, but three stay with Wilbur — Joy, Aranea, and Nellie — and Wilbur loves them, though he never forgets Charlotte.",
  },
  c06: {
    title: "Stuart Little",
    author: "E.B. White",
    grade: "3",
    summary:
      "Stuart Little is born into a human family in New York City — Mr. and Mrs. Frederick C. Little, their son George, and a cat named Snowbell — but he is a mouse: only two inches tall, with whiskers and a tail. The family loves him and makes adjustments (a tiny bed, miniature clothes). Stuart has many small adventures: he gets accidentally rolled into a window shade and stuck for hours, falls into a kitchen drain searching for his mother's lost ring (and has to be rescued), and is briefly mistaken for a baby and taken away by the garbage truck. Stuart sails a model boat called the Wasp in a race in Central Park against a model schooner called the Lillian. He becomes friends with a small bird named Margalo who lives in the Little family's home, but Snowbell tries to eat her, and she escapes to the north. Stuart sets off in a tiny car to find her, traveling north out of the city. Along the way he visits a small town, briefly serves as a substitute schoolteacher, and meets a girl his size named Harriet Ames whom he takes on a date (which goes badly). The book ends with Stuart continuing his journey north, still hopeful he'll find Margalo — leaving the search unresolved.",
  },
  c07: {
    title: "Because of Winn-Dixie",
    author: "Kate DiCamillo",
    grade: "3",
    summary:
      "Ten-year-old India Opal Buloni has just moved to the small town of Naomi, Florida, with her father, whom she calls 'the preacher.' Her mother left them when Opal was three, and Opal misses her. One day, Opal is sent to the Winn-Dixie supermarket for groceries. She finds a big, ugly, smiling stray dog causing chaos in the store. To save him from animal control, she claims he is hers and names him Winn-Dixie. The preacher reluctantly lets her keep him. Because of Winn-Dixie, Opal meets people she might never have known: Miss Franny Block, an elderly librarian with stories about her great-grandfather and a bear; Gloria Dump, a nearly-blind elderly woman with a 'mistake tree' hung with bottles representing her past mistakes; Otis, a quiet pet-store clerk who plays guitar and was once in prison; and three local kids — sisters Amanda Wilkinson, Stevie and Dunlap Dewberry. Opal asks her father to tell her ten things about her mother — and he does. She plans a party at Gloria's, complete with egg salad sandwiches and 'Littmus Lozenges' (a candy that tastes like sadness). A thunderstorm scares Winn-Dixie and he runs away. The whole new community searches for him together, and they find him hiding under Gloria's bed. Opal forgives her mother and accepts that she may never come back.",
  },
  c08: {
    title: "Geronimo Stilton: Lost Treasure of the Emerald Eye",
    author: "Geronimo Stilton",
    grade: "3",
    summary:
      "Geronimo Stilton is the editor of The Rodent's Gazette, a newspaper in New Mouse City on Mouse Island. He is small, scholarly, nervous, and prefers his quiet life. One day his cousin Trap Stilton bursts in with a treasure map for the lost treasure of the Emerald Eye, hidden on a faraway tropical island. Trap insists they go look for it. Geronimo refuses but his sister Thea (an adventurous reporter) and his nine-year-old nephew Benjamin team up with Trap and drag him along. They charter a boat captained by the rough sea-cat — no, sea-mouse — Captain Stiltonitz. They sail through storms, get shipwrecked on the island, and encounter dangers including a giant snake, quicksand, and head-spinning jungle vines. Trap nearly gets them killed many times because he is reckless and refuses to read directions. Geronimo's careful map-reading and bravery (which surprises even him) saves them repeatedly. They find the treasure — but it turns out to be not gold but priceless ancient mouse artifacts. They donate them to the Mouse Museum and return home. Geronimo learns he is braver than he thought.",
  },
};

// Pool size: 12 questions per book, 5 per attempt, 4/5 to pass (80%).
// SAME shape for every book in the catalog — Beginning Readers used to get a
// 3-question quiz, but that was gameable by guessing (~16% pass-by-chance
// per attempt vs ~0.7% on a 5-question 4/5 quiz). Questions are still
// calibrated to the kid's grade via GRADE_GUIDANCE; only the count is fixed.
const POOL_SIZE_FULL = 12;
function poolSizeFor(_style) {
  return POOL_SIZE_FULL;
}

// Quiz pool schema — uniform shape across the whole catalog.
function quizSchemaFor(_style) {
  return z.object({
    questions: z
      .array(
        z.object({
          q: z
            .string()
            .describe(
              "The question, in simple words a 5-year-old can read or hear read aloud."
            ),
          options: z
            .array(z.string())
            .length(4)
            .describe("Exactly 4 answer choices, all plausible to a child."),
          answer: z
            .number()
            .int()
            .min(0)
            .max(3)
            .describe("Index (0-3) of the correct option."),
        })
      )
      .length(POOL_SIZE_FULL),
  });
}
const QuizSchema = quizSchemaFor();

// QC reviewer schema — a structured rubric for each question.
const QCSchema = z.object({
  reviews: z.array(
    z.object({
      questionIndex: z.number().int().min(0),
      accuracy: z
        .number()
        .int()
        .min(0)
        .max(10)
        .describe(
          "0 = clearly wrong or references something not in the book; " +
            "10 = unambiguously answerable from the canonical summary."
        ),
      issues: z
        .array(z.string())
        .optional()
        .describe("Specific problems found, if any."),
    })
  ),
});

// Bump the schema version whenever we change shape — old cached entries are
// then ignored automatically (cache key includes the version).
// v3: pool size 8 → 12 + 27 new books backfilled
// v4: cache keyed by (book, studentGrade) — quizzes are grade-leveled to
//     the reader, not the book. A G2 reading a K book gets G2-level questions.
// v5: switched generation model Haiku 4.5 → Opus 4.5 and added a separate
//     Opus 4.5 QC reviewer pass that drops questions with accuracy < 7/10.
// v6: multi-pass cross-validation (1g) — 3 independent generation runs at
//     temperatures 0.4/0.7/1.0, semantic clustering keeps only consensus
//     questions (appearing in ≥2 runs), then QC accuracy review.
// v7: emergent quiz style (Beginning Readers tier) — 6 questions in pool,
//     literal-recall rubric with Dolch + CVC vocabulary constraint, separate
//     cache namespace.
// v8: emergent quiz style RETIRED. All books now use the 12-question pool /
//     5-per-attempt / 4-of-5-to-pass pipeline. PK readers get K-style
//     literal-recall guidance via GRADE_GUIDANCE.PK so questions stay
//     age-appropriate. Cache namespace bump invalidates all v7 emergent
//     pools, forcing them to regenerate as 12-question pools on next request.
const SCHEMA_VERSION = 8;
// Exported alias so api/activity.js can build the same cache key when it
// validates a quiz_submit. Kept as a renamed export so the local const can
// be reassigned independently if we ever split client / server schemas.
export const QUIZ_SCHEMA_VERSION = SCHEMA_VERSION;

/**
 * Remove the answer index from a question before shipping to the client.
 * The Redis-cached pool keeps the full {q, options, answer} so the server
 * can grade quiz_submit; the wire payload to the browser is only
 * {q, options}. Closes the DevTools answer-reveal vector.
 */
function stripAnswerKey(q) {
  return { q: q.q, options: q.options };
}

/**
 * Read the cached quiz pool for (bookId, studentGrade, ageGrade).
 * Returns the full payload (questions WITH the answer index) or null.
 * Used by activity.js to grade a submitted quiz against the same pool
 * the kid was shown — the cache is the ONLY source of truth for what
 * the correct answer was.
 *
 * IMPORTANT — cache key MUST match the writer in the /api/quiz handler:
 *   ageGrade && ageGrade !== studentGrade
 *     ? "v{V}:{bookId}:{studentGrade}:age{ageGrade}"
 *     : "v{V}:{bookId}:{studentGrade}"
 * A kid with ageGrade ≠ workingGrade (e.g. age 2 reading at K level)
 * was hitting a different key on the read path and getting either a
 * 409 no_quiz_pool OR a wrong-answer-key grading (every submit = 0/5).
 *
 * ageGrade is optional — pre-#9 callers may not have it; in that case
 * we fall through to the legacy single-grade key.
 */
export async function getCachedQuizPool(bookId, studentGrade, ageGrade) {
  const key =
    ageGrade && ageGrade !== studentGrade
      ? `v${SCHEMA_VERSION}:${bookId}:${studentGrade}:age${ageGrade}`
      : `v${SCHEMA_VERSION}:${bookId}:${studentGrade}`;
  try {
    return await getCachedQuiz(key);
  } catch {
    return null;
  }
}

// Quiz model + QC reviewer model. Opus 4.5 for both — generation needs the
// stronger model for accuracy on lesser-known books; QC needs it to reliably
// flag the rare hallucination that slips through.
const GEN_MODEL = "claude-opus-4-5";
const QC_MODEL  = "claude-opus-4-5";

// QC accuracy threshold. Anything below this gets dropped from the pool.
const QC_MIN_ACCURACY = 7;
// Minimum survivors — below this, the pool is unusable and we fail
// rather than serving a tiny quiz. Uniform across all books now that
// emergent has been retired.
const MIN_USABLE_POOL_FULL = 8;
function minUsableFor(_style) {
  return MIN_USABLE_POOL_FULL;
}

// Multi-pass cross-validation (1g). When enabled, we generate the pool 3
// times at different temperatures, cluster semantically, and keep only the
// consensus questions. Set QUIZ_MULTI_PASS=0 in env to fall back to single-pass.
const MULTI_PASS_ENABLED = process.env.QUIZ_MULTI_PASS !== "0";
// Temperatures for the 3 independent passes. Spread keeps the runs
// genuinely different so consensus = real consensus, not just identical
// re-runs of the same temperature.
const MULTI_PASS_TEMPS = [0.4, 0.7, 1.0];
// A question must appear in at least this many distinct runs to survive.
// With 3 runs, threshold 2 = "the model agrees on this from at least 2 of
// 3 random seeds" — a strong signal it's not a one-off hallucination.
const MULTI_PASS_CONSENSUS_THRESHOLD = 2;

// DIFFICULTY rubric — keyed to the student's WORKING grade. Controls
// vocabulary depth, inference complexity, sentence length. The book
// itself stays the same; questions adapt to what the kid can decode +
// reason about.
const GRADE_GUIDANCE = {
  PK:
    "Test LITERAL RECALL only — who, what, where, how many. Use only the " +
    "simplest words (Dolch first-100 sight words + short CVC words + proper " +
    "names from the book). Keep questions under 10 words and options under " +
    "5 words. AVOID inference, theme, sequence, or any abstract concept.",
  K:
    "Test LITERAL RECALL — what happened, who appeared, what they ate, " +
    "basic colors and counts. Use very simple, concrete words a five-year-old " +
    "would know. AVOID inference, theme, or abstract concepts.",
  "1":
    "Test recall plus simple SEQUENCE (what happened first, next, last) " +
    "and BASIC CAUSE-AND-EFFECT (why was the character sad? what did the " +
    "character do next?). Use simple-to-moderate vocabulary.",
  "2":
    "Test recall, INFERENCE (what the character was feeling, what they " +
    "might do next, why they made a choice), sequence, cause-and-effect, " +
    "and the LESSON OR THEME of the story. Multi-step thinking is " +
    "appropriate. Use full grade-appropriate vocabulary.",
  "3":
    "Test DEEPER INFERENCE, theme, character motivation, prediction, and " +
    "author's purpose. Vocabulary can be richer. Some questions can ask " +
    "the student to synthesize information across the whole story.",
  "4":
    "Same as Grade 3 but with more complex inference and analytical " +
    "thinking. Compare/contrast questions are appropriate.",
  "5":
    "Same as Grade 4 with richer vocabulary, more sophisticated inference, " +
    "and analysis of literary technique where relevant.",
};

// MATURITY rubric — keyed to the student's AGE grade (physical age),
// SEPARATE from working grade. Controls the FRAMING of distractors and
// the tone of the question — what kinds of "wrong-but-plausible" answers
// feel right for a kid that age, what reference points they understand
// (recess vs nap-time, etc.), and whether the language can assume basic
// social context (peer pressure, sportsmanship, etc.).
//
// Task #30: a 4th-grader reading at G2 working level gets G2-level
// difficulty but with FRAMING that doesn't feel babyish — distractors
// reference school playground / siblings / pets, not toddler-level
// scenarios. Without this, a kid reading below grade level felt
// infantilized by their distractors even when the question vocab fit.
const MATURITY_GUIDANCE = {
  PK:
    "Frame distractors around toddler-world scenes: parents, naps, " +
    "blocks, snack, animals at home, big-or-little objects. Keep the " +
    "tone gentle and warm.",
  K:
    "Frame distractors around early-school scenes: storytime, cubbies, " +
    "lunch, sharing, the playground, simple feelings (happy/sad/scared). " +
    "Tone is gentle and encouraging.",
  "1":
    "Frame distractors around 6-7-year-old life: school routines, " +
    "siblings, family, recess, friendship moments. Light humor is fine. " +
    "Avoid scenarios that require nap-time / toddler context.",
  "2":
    "Frame distractors around 7-8-year-old life: classroom dynamics, " +
    "playground games, family events, simple peer interactions, basic " +
    "fairness. Avoid both nap-time framing AND adult-level conflict.",
  "3":
    "Frame distractors around 8-9-year-old life: clubs and teams, " +
    "school projects, sibling rivalries, sportsmanship, simple moral " +
    "dilemmas. Tone is warm but not babyish — no preschool framing.",
  "4":
    "Frame distractors around 9-10-year-old life: friendships and " +
    "social groups, independence, perseverance, fairness, peer " +
    "pressure. Tone is engaged and respectful — never condescending.",
  "5":
    "Frame distractors around 10-11-year-old life: identity, fairness, " +
    "loyalty, deeper moral choices, light irony where the book supports " +
    "it. Tone respects the reader as a capable thinker.",
  "6":
    "Frame distractors around 11-12-year-old life: identity, " +
    "consequence, hypocrisy, social complexity, broader cultural " +
    "context. The reader is approaching middle-school maturity.",
  "7":
    "Frame distractors at full middle-school maturity: peer dynamics, " +
    "moral ambiguity, real-world consequence, light irony.",
  "8":
    "Same as Grade 7 with more sophisticated themes and a slightly " +
    "more analytical tone.",
};

// One generation pass — extracted so the multi-pass orchestrator can call
// it N times in parallel at different temperatures. The prompt is identical
// across runs; only `temperature` varies. Returns the array of questions
// (poolSize long for the book's style) or throws.
async function generateOnce(book, studentGrade, guidance, temperature, ageGrade) {
  const poolSize = POOL_SIZE_FULL;
  const schema = quizSchemaFor();

  // PK-leveled prompts deliberately tighten the vocabulary + length rules
  // to keep questions readable for a 4-5 year old. Everything else uses
  // the standard grade-calibrated comprehension prompt.
  const isPreK = String(studentGrade || "").toUpperCase() === "PK";
  // Age grade falls back to working grade when missing — same maturity
  // as the difficulty floor in that case (matches old behavior).
  const ageGradeKey = String(ageGrade || studentGrade || "K").toUpperCase();
  const maturityRubric =
    MATURITY_GUIDANCE[ageGradeKey] || MATURITY_GUIDANCE[studentGrade] || "";
  const includeMaturity =
    maturityRubric && String(ageGrade || "").toUpperCase() !== String(studentGrade || "").toUpperCase();

  const system =
    `You are an early-elementary reading specialist designing reading-` +
    `comprehension questions for a GRADE ${studentGrade} reader.\n\n` +
    `DIFFICULTY CALIBRATION for Grade ${studentGrade} (vocabulary, ` +
    `inference depth, sentence length):\n${guidance}\n\n` +
    (includeMaturity
      ? `MATURITY CALIBRATION — this student is age-Grade ${ageGrade} but ` +
        `reads at Grade ${studentGrade}. Keep the DIFFICULTY at Grade ` +
        `${studentGrade} (above), but the FRAMING of distractors and the ` +
        `tone of questions should match Grade ${ageGrade}. Don't use ` +
        `toddler/preschool framing for an older kid even when their ` +
        `reading level is below grade. Maturity rubric:\n${maturityRubric}\n\n`
      : "") +
    `Tone: warm and concrete. Each question has EXACTLY 4 options, ONE ` +
    `of which is clearly correct. The other three should be plausible-` +
    `but-wrong things a kid who skimmed might pick. Vary which index ` +
    `(0,1,2,3) is correct across all questions — don't bunch the ` +
    `correct answers at the same position.\n\n` +
    `CRITICAL: Only ask about details that are explicitly in the plot ` +
    `summary provided. Do NOT invent characters, events, items, or ` +
    `numbers. If you can't verify a detail in the summary, do NOT use ` +
    `it as a question or distractor.`;

  const lengthRules = isPreK
    ? `- Keep each question under 10 words.\n` +
      `- Keep each option under 5 words.\n` +
      `- Use only Dolch first-100 sight words + CVC patterns + proper ` +
      `  names that appear in the book.\n`
    : `- Keep each question under 18 words.\n` +
      `- Keep each option under 8 words.\n`;

  const prompt =
    `Write ${poolSize} reading-comprehension questions for the book ` +
    `"${book.title}" by ${book.author}.\n\n` +
    `The student is in Grade ${studentGrade}. The book is recommended ` +
    `for Grade ${book.grade} readers. If the student is OLDER than the ` +
    `book's level, still calibrate questions to the STUDENT's grade — ` +
    `don't dumb them down just because the book is short. If the student ` +
    `is YOUNGER than the book, keep questions simple even though the ` +
    `book is more advanced.\n\n` +
    `Plot summary (the source of truth — do NOT quote it verbatim, ` +
    `but every question must be answerable from these details):\n${book.summary}\n\n` +
    `The questions should cover DIFFERENT aspects of the book so that any random ` +
    `subset of 5 still tests broad comprehension.\n\n` +
    `Hard rules:\n` +
    `- Avoid trick questions.\n` +
    lengthRules +
    `- No two questions should be near-duplicates.\n` +
    `- Every fact you assert must appear in the plot summary above.`;

  const { object } = await generateObject({
    model: anthropic(GEN_MODEL),
    schema,
    temperature,
    system,
    prompt,
  });
  return object.questions;
}

// QC reviewer: takes a freshly-generated pool of questions and scores each
// for accuracy against the book's canonical summary. Drops questions with
// accuracy below QC_MIN_ACCURACY. Returns { questions: [keepers], dropped: [{idx, accuracy, issues}] }.
async function qcAndFilter(book, studentGrade, questions) {
  const letters = ["A", "B", "C", "D"];
  const formatted = questions
    .map(
      (q, i) =>
        `${i}. ${q.q}\n   A) ${q.options[0]}\n   B) ${q.options[1]}\n   ` +
        `C) ${q.options[2]}\n   D) ${q.options[3]}\n   ` +
        `[marked correct: ${letters[q.answer]}]`
    )
    .join("\n\n");

  let reviews;
  try {
    const { object } = await generateObject({
      model: anthropic(QC_MODEL),
      schema: QCSchema,
      system:
        "You are a strict reading-comprehension QC reviewer for an " +
        "elementary-school reading app. Your job: catch hallucinations and " +
        "inaccuracies in AI-generated quiz questions.\n\n" +
        "For each question, verify it against the canonical plot summary. " +
        "Score 0-10:\n" +
        "  10 = unambiguously answerable from the summary; correct answer is " +
        "clearly correct; distractors are plausible-but-wrong\n" +
        "   7 = workable but minor wording issue (still ship it)\n" +
        "   4 = answer is questionable, or 2+ options could be defended as correct\n" +
        "   0 = fabricated detail not in the book, wrong answer, or " +
        "unanswerable from the summary\n\n" +
        "Be skeptical. If a question references a character name, number, " +
        "color, action, or event you can't find in the summary, score it LOW. " +
        "Don't pad scores to be nice — accuracy matters more than volume.",
      prompt:
        `Book: "${book.title}" by ${book.author}\n` +
        `Grade level (calibration target): ${studentGrade}\n\n` +
        `Canonical plot summary (the ONLY source of truth):\n${book.summary}\n\n` +
        `Questions to review:\n\n${formatted}\n\n` +
        `For EVERY question (indexes 0 through ${questions.length - 1}), ` +
        `return an entry with that index, an accuracy score, and any specific ` +
        `issues you found. Do not skip any.`,
    });
    reviews = object.reviews || [];
  } catch (err) {
    // QC call failed — degrade gracefully by accepting all generated questions.
    // Better to serve a (possibly imperfect) quiz than to block on QC failure.
    console.warn("[quiz_qc_failed]", String(err?.message || err));
    return { questions, dropped: [] };
  }

  const reviewByIdx = new Map();
  for (const r of reviews) reviewByIdx.set(r.questionIndex, r);

  const survivors = [];
  const dropped = [];
  for (let i = 0; i < questions.length; i++) {
    const r = reviewByIdx.get(i);
    // If QC didn't review a question (model omission), keep it but log.
    if (!r) {
      survivors.push(questions[i]);
      continue;
    }
    if (r.accuracy >= QC_MIN_ACCURACY) {
      survivors.push(questions[i]);
    } else {
      dropped.push({
        idx: i,
        accuracy: r.accuracy,
        issues: r.issues || [],
        question: questions[i].q,
      });
    }
  }

  if (dropped.length > 0) {
    console.log(
      `[quiz_qc] ${book.title} grade=${studentGrade}: kept ${survivors.length}/${questions.length}`,
      dropped.map((d) => `Q${d.idx}(${d.accuracy})`).join(", ")
    );
  }

  return { questions: survivors, dropped };
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  const secret = process.env.AUTH_SECRET;
  const cookies = parseCookies(req.headers.cookie);
  const session = await verifySession(cookies.rs_session, secret);
  if (!session) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: "unauthenticated" }));
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const bookId = url.searchParams.get("bookId");

  if (!bookId || !QUIZ_BOOKS[bookId]) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ available: false, bookId }));
  }

  // Look up the book up front so we know its quiz style (and minimum
  // usable pool size) before we touch the cache.
  const book = QUIZ_BOOKS[bookId];

  // Resolve the student's working grade + track overrides from their Redis
  // profile, falling back to email heuristic. This drives both the quiz
  // calibration AND the track-visibility check below.
  let profileGrade = null;
  let profileAgeGrade = null;
  let trackOverrides = {};
  const r = redis();
  if (r) {
    try {
      const raw = await r.hget("users", String(session.email).toLowerCase());
      if (raw) {
        const prof = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (prof?.grade) profileGrade = prof.grade;
        if (prof?.ageGrade) profileAgeGrade = prof.ageGrade;
        if (prof?.trackOverrides) trackOverrides = prof.trackOverrides;
      }
    } catch {
      /* fall through to email heuristic */
    }
  }
  const studentGrade = normalizeGrade(
    profileGrade || guessGradeFromEmail(session.email) || "K"
  );
  // Age grade is OPTIONAL — TimeBack supplies it via the working-grade
  // sync cron. When missing, fall back to studentGrade so the prompt
  // ignores the maturity rubric (same behavior as before task #30).
  const ageGrade = profileAgeGrade
    ? normalizeGrade(profileAgeGrade)
    : studentGrade;

  // Track-visibility enforcement (#14). If admin has locked this book's
  // track for this student (or default rule hides it), refuse to serve the
  // quiz. Prevents bypassing the UI filter with a direct bookId fetch.
  // Admins bypass — they need QA access to every book regardless of grade.
  const bookTrack = trackForBook(book);
  const visible = resolveVisibleTracks(studentGrade, trackOverrides);
  if (!isAdmin(session.email) && bookTrack && !visible.includes(bookTrack)) {
    res.statusCode = 403;
    return res.end(
      JSON.stringify({
        error: "track_locked",
        bookId,
        bookTrack,
        visibleTracks: visible,
        message:
          "This book is on a track that hasn't been unlocked for you.",
      })
    );
  }

  // CurrentlyReading enforcement — the kid must have declared they're
  // reading THIS book before they can take its quiz. Prevents quiz-
  // hopping across books they haven't claimed to be working on.
  const activeRead = await getCurrentlyReading(session.email);
  if (!activeRead || activeRead.bookId !== bookId) {
    res.statusCode = 403;
    return res.end(
      JSON.stringify({
        error: "not_currently_reading",
        bookId,
        currentlyReading: activeRead || null,
        message:
          "Tap \"I'm reading this\" on the book first so we know it's the one you're working on.",
      })
    );
  }
  const style = book.quizStyle || "comprehension";
  const minUsable = minUsableFor(style);

  // Cache key: (book, working grade, age grade). Different working grades
  // get different question pools because difficulty is calibrated to the
  // reader. Different (working, age) PAIRS also get different pools
  // because the maturity rubric reshapes distractors when age ≠ working.
  // To preserve old-cache compatibility for the common same-grade case,
  // we only suffix age when it differs.
  const cacheKey =
    ageGrade && ageGrade !== studentGrade
      ? `v${SCHEMA_VERSION}:${bookId}:${studentGrade}:age${ageGrade}`
      : `v${SCHEMA_VERSION}:${bookId}:${studentGrade}`;
  const cached = await getCachedQuiz(cacheKey);
  if (
    cached &&
    Array.isArray(cached.questions) &&
    cached.questions.length >= minUsable
  ) {
    // #41: count this open. Used as a fraud signal in /api/activity
    // quiz_submit — opens-without-submit pattern feeds the soft-flag
    // matrix. Fire-and-forget; failures here mustn't block the response.
    recordQuizOpen(session.email, bookId).catch(() => {});
    res.statusCode = 200;
    res.setHeader("Cache-Control", "private, max-age=86400");
    return res.end(
      JSON.stringify({
        available: true,
        bookId,
        poolSize: cached.questions.length,
        studentGrade,
        quizStyle: style,
        cached: true,
        ...cached,
        // SECURITY: strip the answer key before sending to the client.
        // The cached pool keeps answers for server-side grading via
        // /api/activity kind:"quiz_submit"; clients never see them. This
        // closes the DevTools-reveal attack (kid opens console, reads
        // question.answer, taps the right option).
        questions: cached.questions.map(stripAnswerKey),
      })
    );
  }

  const guidance = GRADE_GUIDANCE[studentGrade] || GRADE_GUIDANCE.K;

  try {
    // ---------- Generation: multi-pass cross-validation (1g) ----------
    // Run POOL generations in parallel at different temperatures. Settled
    // promises let us tolerate 1-2 failures and still cluster on what we got.
    let candidates; // Array<Array<Question>> — one entry per successful run
    let multiPassStats = null;

    if (MULTI_PASS_ENABLED) {
      const settled = await Promise.allSettled(
        MULTI_PASS_TEMPS.map((t) =>
          generateOnce(book, studentGrade, guidance, t, ageGrade)
        )
      );
      const successful = settled
        .filter((s) => s.status === "fulfilled")
        .map((s) => s.value);
      const failed = settled.length - successful.length;
      if (successful.length === 0) {
        // All passes failed — bubble up.
        throw settled[0]?.reason || new Error("all_generations_failed");
      }
      if (failed > 0) {
        console.warn(
          `[quiz_multi_pass_partial] ${bookId} grade=${studentGrade}: ` +
            `${successful.length}/${settled.length} runs succeeded`
        );
      }
      candidates = successful;
    } else {
      // Single-pass fallback — env-toggleable for A/B comparison.
      const questions = await generateOnce(
        book,
        studentGrade,
        guidance,
        0.7, // sensible default
        ageGrade
      );
      candidates = [questions];
    }

    // Cluster across runs, keep only consensus questions (≥2 of 3 runs).
    // If only one run came back, this returns it as-is.
    const consensus = await clusterAndExtractConsensus(candidates, {
      bookTitle: book.title,
      bookSummary: book.summary,
      consensusThreshold: MULTI_PASS_CONSENSUS_THRESHOLD,
      targetPoolSize: poolSizeFor(style),
    });
    multiPassStats = consensus.stats;

    if (multiPassStats && multiPassStats.totalCandidates > 0) {
      console.log(
        `[quiz_multi_pass] ${bookId} grade=${studentGrade}: ` +
          `${multiPassStats.totalCandidates} candidates → ` +
          `${multiPassStats.clusterCount} clusters → ` +
          `${multiPassStats.survivingClusters} consensus`
      );
    }

    // ---------- QC reviewer pass (Opus 4.5) ----------
    // Independent second opinion: score each consensus question for
    // accuracy against the canonical summary. Drop low-scoring questions.
    const reviewedPool = await qcAndFilter(
      book,
      studentGrade,
      consensus.questions
    );

    if (reviewedPool.questions.length < minUsable) {
      // Too many questions failed QC to produce a usable quiz.
      console.error(
        "[quiz_qc_too_strict]",
        bookId,
        studentGrade,
        "survivors:",
        reviewedPool.questions.length,
        "of",
        consensus.questions.length,
        `(style=${style}, min=${minUsable})`
      );
      res.statusCode = 500;
      return res.end(
        JSON.stringify({
          error: "qc_no_viable_questions",
          message:
            "The quiz generator produced too many low-quality questions for this book. Try again — the next run will regenerate from scratch.",
        })
      );
    }

    // ---------- Safety moderation pass (deterministic) ----------
    // QC reviews accuracy; this filters content. Drops any question
    // whose text or options trips the profanity / PII filter — same
    // list the student-comment moderator uses, lifted to lib/moderation.js.
    // Opus 4.5 is well-aligned so this rarely fires, but Agent 6 flagged
    // "Opus QCs itself with no independent moderation" as catastrophic.
    // Deterministic filter = the cheap first line; an LLM safety pass
    // (more nuanced) is a separate follow-up task.
    const safe = moderateQuizQuestions(reviewedPool.questions);
    if (safe.dropped.length > 0) {
      console.warn(
        `[quiz_safety_dropped] ${bookId} grade=${studentGrade}: ` +
          `${safe.dropped.length} question(s) dropped`,
        safe.dropped.map((d) => `#${d.idx}:${d.reason}`).join(", ")
      );
    }
    if (safe.kept.length < minUsable) {
      console.error(
        "[quiz_safety_too_strict]",
        bookId,
        studentGrade,
        "survivors:",
        safe.kept.length,
        "of",
        reviewedPool.questions.length
      );
      res.statusCode = 500;
      return res.end(
        JSON.stringify({
          error: "safety_no_viable_questions",
          message:
            "The quiz needs to be regenerated — please try again in a moment.",
        })
      );
    }

    const payload = {
      questions: safe.kept,
      qc: {
        generated: consensus.questions.length,
        kept: reviewedPool.questions.length,
        afterSafety: safe.kept.length,
        dropped: reviewedPool.dropped,
        droppedForSafety: safe.dropped,
      },
      multiPass: multiPassStats,
    };
    await setCachedQuiz(cacheKey, payload);

    // #41: count this open (cold-path mirror of the cached-hit branch).
    recordQuizOpen(session.email, bookId).catch(() => {});
    res.statusCode = 200;
    return res.end(
      JSON.stringify({
        available: true,
        bookId,
        poolSize: reviewedPool.questions.length,
        studentGrade,
        quizStyle: style,
        cached: false,
        ...payload,
        // SECURITY: strip the answer key before sending. The cache still
        // has the full answers for server-side grading; clients don't.
        questions: payload.questions.map(stripAnswerKey),
      })
    );
  } catch (err) {
    console.error("quiz_generation_failed", err);
    await trackError("quiz_generation_failed", err, { bookId, studentGrade });
    res.statusCode = 500;
    return res.end(
      JSON.stringify({
        error: "quiz_generation_failed",
        message:
          "Couldn't build the quiz right now. Check ANTHROPIC_API_KEY is set on the Vercel project. Try again in a minute.",
      })
    );
  }
}
